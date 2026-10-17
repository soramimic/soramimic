import { syllableVariations, longVowelExpansion } from "./kanaToSyllable.js";

// Store one pronunciation, sharing it across its reachable length buckets.
// N long vowels need N+1 references, rather than 2**N copied pronunciations.
export function indexPronunciation(db, word, maximum=Infinity){
	const units = word.pronunciation;
	const extra = units.reduce((sum,unit)=>sum+Number(!!longVowelExpansion(unit)),0);
	for(let size=units.length;size<=Math.min(maximum,units.length+extra);size++){
		(db[size] ||= []).push(word);
	}
}

// Each local alternative rejoins the following syllable. Node order is
// topological, and an edge emits at most one unit (or a deletion).
function pronunciationGraph(levels){
	const nodes = [[]];
	let start = 0;
	for(const {source,options} of levels){
		const branches = options.map(option=>({
			...option, middle:option.units.slice(1).map(()=>nodes.push([])-1),
		}));
		const end = nodes.push([])-1;
		for(const {units,cost,middle} of branches){
			const path = [start,...middle,end];
			for(let i=0;i<Math.max(1,units.length);i++){
				nodes[path[i]].push({end:path[i+1],unit:units[i]??null,
					cost:i===0 ? cost : 0,source});
			}
		}
		start = end;
	}
	return nodes;
}
let wordGraphs = new WeakMap();
let wordGraphCount = 0;
function longWordGraph(units){
	if(!wordGraphs.has(units)){
		// Live dictionaries can retain many entries; bound the derived graph cache too.
		if(wordGraphCount>=256){ wordGraphs = new WeakMap(); wordGraphCount = 0; }
		wordGraphs.set(units,pronunciationGraph(units.map((unit,source)=>({
			source,options:[{units:[unit],cost:0},
				...(longVowelExpansion(unit) ? [{units:longVowelExpansion(unit),cost:0}] : [])],
		}))));
		wordGraphCount++;
	}
	return wordGraphs.get(units);
}

// Equivalent algorithms: this switches representation, never drops alternatives.
const MAX_ENUMERATED_VARIATIONS = 256;
const MAX_EXPANDED_LYRIC_VARIANTS = 16;

export class PronunciationSearch {
	// Diagnostics may restrict alternatives without changing normal searches.
	constructor(target, lengths, {expandLongVowels=true, allowSoundChanges=true}={}){
		this.levels = target.flatMap((syllable, source)=>syllable === null ? [] : [{
			source, options: syllableVariations(syllable,expandLongVowels)
				.filter(({c})=>allowSoundChanges || c===0).map(({u,c})=>({
				units:u.filter(unit=>unit!==""), cost:c,
			})),
		}]);
		const wanted = new Set([...lengths].map(Number).filter(n=>Number.isInteger(n) && n>0));
		const maximum = Math.max(0,...wanted);
		let counts = new Map([[0,1]]);
		for(const {options} of this.levels){
			const next = new Map();
			for(const [prefix,count] of counts)for(const {units} of options){
				const size = prefix+units.length;
				if(size<=maximum)next.set(size,Math.min(MAX_ENUMERATED_VARIATIONS+1,
					(next.get(size)||0)+count));
			}
			counts = next;
		}
		this.lengths = [...wanted].filter(n=>counts.has(n)).sort((a,b)=>a-b);
		this.smallExpansionLengths = this.lengths.filter(n=>counts.get(n)<=MAX_EXPANDED_LYRIC_VARIANTS);
		// Small-query enumeration also includes lengths absent from the dictionary.
		this.compact = [...counts.values()].reduce((a,b)=>a+b,0)>MAX_ENUMERATED_VARIATIONS;
		this.maximum = maximum;
		this.suffixMin = Array(this.levels.length+1).fill(0);
		this.suffixMax = Array(this.levels.length+1).fill(0);
		let maxOperations = 0;
		for(let i=this.levels.length-1;i>=0;i--){
			const {options} = this.levels[i];
			this.suffixMin[i] = this.suffixMin[i+1]+Math.min(...options.map(o=>o.units.length));
			this.suffixMax[i] = this.suffixMax[i+1]+Math.max(...options.map(o=>o.units.length));
			maxOperations += Math.max(...options.map(o=>o.cost));
		}
		this.stride = maxOperations+1;
	}

	// Reachable (length, operation count) pairs let coarse scoring start with the
	// final variation penalty, just as the enumerating matcher does. Built lazily.
	prepareSuffixCosts(){
		if(this.suffixCosts)return;
		this.suffixCosts = Array(this.levels.length+1);
		this.suffixCosts[this.levels.length] = new Set([0]);
		for(let i=this.levels.length-1;i>=0;i--){
			const next = new Set();
			for(const key of this.suffixCosts[i+1]){
				const length = Math.floor(key/this.stride), cost = key%this.stride;
				for(const option of this.levels[i].options){
					const size = length+option.units.length;
					if(size<=this.maximum)next.add(size*this.stride+cost+option.cost);
				}
			}
			this.suffixCosts[i] = next;
		}
	}

	score(pronunciation, kanaDist, variationCost=0, wordCost=0, weights=null){
		if(!this.lengths.includes(pronunciation.length))return Infinity;
		if(pronunciation.some(unit=>!(unit in kanaDist)))return Infinity;
		const extend = (score,unit,position,weight)=>{
			if(!(unit in kanaDist))return Infinity;
			return score+kanaDist[unit][pronunciation[position]]*weight;
		};
		return this.distance(pronunciation.length,extend,variationCost,wordCost,weights);
	}

	coarseScore(pronunciation, unitFeature, vowelRatio=0.8, variationWeight=1,
		wordCost=0, weights=null, targetLength=pronunciation.length){
		if(!this.lengths.includes(targetLength))return Infinity;
		// coarseSignature stores features with String.fromCharCode (16 bits).
		const feature = unit=>unitFeature(unit)&65535;
		const wordFeatures = pronunciation.map(feature);
		const extend = (score,unit,position,weight)=>{
			const targetFeature = feature(unit), wordFeature = wordFeatures[position];
			// Keep the two additions separate, including the initial penalty below:
			// regrouping floating-point sums could change ties in the shortlist.
			if((targetFeature>>>8)!==(wordFeature>>>8))score += 5*vowelRatio*weight;
			if((targetFeature&255)!==(wordFeature&255))score += 5*(1-vowelRatio)*weight;
			return score;
		};
		if(!variationWeight)return this.distance(targetLength,extend,0,wordCost,weights,0);
		this.prepareSuffixCosts();
		let best = Infinity;
		for(let cost=0;cost<this.stride;cost++){
			if(!this.suffixCosts[0].has(targetLength*this.stride+cost))continue;
			best = Math.min(best,this.distance(targetLength,extend,variationWeight,wordCost,weights,cost));
		}
		return best;
	}

	// Match the two pronunciation graphs without enumerating either product.
	// Dictionary edges only split long vowels, so their operation cost is zero.
	scoreExpanded(pronunciation, length, kanaDist, variationCost=0, wordCost=0, weights=null){
		const extend = (score,left,right,weight)=>left in kanaDist && right in kanaDist
			? score+kanaDist[left][right]*weight : Infinity;
		return this.distanceExpanded(pronunciation,length,extend,variationCost,wordCost,weights);
	}

	coarseScoreExpanded(pronunciation,length,unitFeature,vowelRatio=.8,variationWeight=1,
		wordCost=0,weights=null){
		const extend = (score,left,right,weight)=>{
			const a = unitFeature(left)&65535, b = unitFeature(right)&65535;
			if((a>>>8)!==(b>>>8))score += 5*vowelRatio*weight;
			if((a&255)!==(b&255))score += 5*(1-vowelRatio)*weight;
			return score;
		};
		if(!variationWeight)return this.distanceExpanded(pronunciation,length,extend,0,wordCost,weights,0);
		this.prepareSuffixCosts();
		let best = Infinity;
		for(let cost=0;cost<this.stride;cost++){
			if(!this.suffixCosts[0].has(length*this.stride+cost))continue;
			best = Math.min(best,this.distanceExpanded(pronunciation,length,extend,
				variationWeight,wordCost,weights,cost));
		}
		return best;
	}

	// As with small ン/ッ queries, enumerate only the bounded lyric alternatives.
	// The word stays compact: prefixes with the same expansion count share a score.
	prepareExpandedVariants(length){
		this.expandedVariants ||= new Map();
		if(this.expandedVariants.has(length))return this.expandedVariants.get(length);
		let prefixes = [{units:[],sources:[],cost:0}];
		for(let level=0;level<this.levels.length;level++){
			const {source,options} = this.levels[level];
			const next = [];
			for(const prefix of prefixes)for(const option of options){
				const size = prefix.units.length+option.units.length;
				if(size+this.suffixMin[level+1]>length || size+this.suffixMax[level+1]<length)continue;
				next.push({units:[...prefix.units,...option.units],
					sources:[...prefix.sources,...option.units.map(()=>source)],cost:prefix.cost+option.cost});
			}
			prefixes = next;
		}
		this.expandedVariants.set(length,prefixes);
		return prefixes;
	}

	distanceExpandedSmall(pronunciation,length,extend,variationCost,wordCost,weights,plannedCost){
		const extra = length-pronunciation.length;
		if(extra<0)return Infinity;
		const expansions = pronunciation.map(longVowelExpansion);
		const remaining = new Uint32Array(pronunciation.length+1);
		for(let i=pronunciation.length-1;i>=0;i--)remaining[i] = remaining[i+1]+Number(!!expansions[i]);
		if(extra>remaining[0])return Infinity;
		const singlePath = extra===0 || extra===remaining[0];
		let current, next;
		if(!singlePath){ current = new Float64Array(extra+1); next = new Float64Array(extra+1); }
		const coarse = plannedCost!==null;
		let best = Infinity;
		for(const variant of this.prepareExpandedVariants(length)){
			if(coarse && variationCost && variant.cost!==plannedCost)continue;
			const initial = coarse ? (plannedCost+wordCost)*variationCost : 0;
			const weightAt = position=>weights && typeof weights[variant.sources[position]]==="number"
				? weights[variant.sources[position]] : 1;
			if(singlePath){
				let score = initial, position = 0;
				for(let i=0;i<pronunciation.length;i++){
					const units = extra ? expansions[i] : null;
					if(units){
						score = extend(score,variant.units[position],units[0],weightAt(position));
						if(!Number.isFinite(score))break;
						position++;
						score = extend(score,variant.units[position],units[1],weightAt(position));
					}else{
						score = extend(score,variant.units[position],pronunciation[i],weightAt(position));
					}
					if(!Number.isFinite(score))break;
					position++;
				}
				if(Number.isFinite(score))best = Math.min(best,coarse ? score : score+(variant.cost+wordCost)*variationCost);
				continue;
			}
			current.fill(Infinity);
			current[0] = initial;
			for(let i=0;i<pronunciation.length;i++){
				next.fill(Infinity);
				for(let used=Math.max(0,extra-remaining[i]);used<=Math.min(extra,remaining[0]-remaining[i]);used++){
					const score = current[used];
					if(!Number.isFinite(score))continue;
					const position = i+used;
					if(used+remaining[i+1]>=extra){
						const value = extend(score,variant.units[position],pronunciation[i],weightAt(position));
						if(Number.isFinite(value) && value<next[used])next[used] = value;
					}
					if(expansions[i] && used<extra && used+1+remaining[i+1]>=extra){
						const [head,vowel] = expansions[i];
						const first = extend(score,variant.units[position],head,weightAt(position));
						if(!Number.isFinite(first))continue;
						const value = extend(first,variant.units[position+1],vowel,weightAt(position+1));
						if(Number.isFinite(value) && value<next[used+1])next[used+1] = value;
					}
				}
				[current,next] = [next,current];
			}
			best = Math.min(best,coarse ? current[extra] : current[extra]+(variant.cost+wordCost)*variationCost);
		}
		return best;
	}

	distanceExpanded(pronunciation,length,extend,variationCost,wordCost,weights,plannedCost=null){
		if(!this.lengths.includes(length))return Infinity;
		if(!this.compact && this.smallExpansionLengths.includes(length))return this.distanceExpandedSmall(pronunciation,length,extend,
			variationCost,wordCost,weights,plannedCost);
		this.graph ||= pronunciationGraph(this.levels);
		const left = this.graph, right = longWordGraph(pronunciation);
		const coarse = plannedCost!==null;
		const rows = Array.from({length:left.length},()=>new Map());
		rows[0].set(0,new Map([[0,coarse ? (plannedCost+wordCost)*variationCost : 0]]));
		const save = (a,b,position,operations,score)=>{
			if(position>length || !Number.isFinite(score)
				|| (coarse && variationCost && operations>plannedCost))return;
			const states = rows[a].get(b) || new Map();
			const key = position*this.stride+operations;
			if(score<(states.get(key)??Infinity))states.set(key,score);
			rows[a].set(b,states);
		};
		for(let a=0;a<left.length-1;a++){
			for(const [b,states] of rows[a])for(const [key,score] of states){
				const position = Math.floor(key/this.stride), operations = key%this.stride;
				for(const edge of left[a]){
					const cost = variationCost ? operations+edge.cost : 0;
					if(edge.unit===null){
						save(edge.end,b,position,cost,score);
						continue;
					}
					const weight = weights && typeof weights[edge.source]==="number" ? weights[edge.source] : 1;
					for(const other of right[b])save(edge.end,other.end,position+1,cost,
						extend(score,edge.unit,other.unit,weight));
				}
			}
			rows[a].clear();
		}
		let best = Infinity;
		for(const [key,score] of rows.at(-1).get(right.length-1)||[]){
			if(Math.floor(key/this.stride)!==length)continue;
			const operations = key%this.stride;
			if(coarse && variationCost && operations!==plannedCost)continue;
			best = Math.min(best,coarse ? score : score+(operations+wordCost)*variationCost);
		}
		return best;
	}

	// Merge prefixes only when their output position and operation count match.
	// Every remaining addition is then identical and monotone, so the smaller
	// prefix gives the same minimum as the full product. Memory is polynomial.
	distance(length, extend, variationCost, wordCost, weights, plannedCost=null){
		const coarse = plannedCost!==null;
		let states = new Map([[0,coarse ? (plannedCost+wordCost)*variationCost : 0]]);
		for(let level=0;level<this.levels.length;level++){
			const {source,options} = this.levels[level];
			const weight = weights && typeof weights[source]==="number" ? weights[source] : 1;
			const next = new Map();
			for(const [key,distance] of states){
				const position = Math.floor(key/this.stride), operations = key%this.stride;
				for(const {units,cost} of options){
					const end = position+units.length;
					if(end+this.suffixMin[level+1]>length || end+this.suffixMax[level+1]<length)continue;
					const nextCost = variationCost ? operations+cost : 0;
					if(coarse && variationCost && (nextCost>plannedCost
						|| !this.suffixCosts[level+1].has((length-end)*this.stride+plannedCost-nextCost)))continue;
					let total = distance;
					for(let i=0;i<units.length;i++)total = extend(total,units[i],position+i,weight);
					const nextKey = end*this.stride+nextCost;
					if(total<(next.get(nextKey)??Infinity))next.set(nextKey,total);
				}
			}
			states = next;
			if(!states.size)return Infinity;
		}
		let best = Infinity;
		for(const [key,distance] of states){
			const score = coarse ? distance : distance+(key%this.stride+wordCost)*variationCost;
			best = Math.min(best,score);
		}
		return best;
	}
}
