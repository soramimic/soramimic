import { syllableVariations } from "./kanaToSyllable.js";

// Equivalent algorithms: this switches representation, never drops alternatives.
const MAX_ENUMERATED_VARIATIONS = 256;

export class PronunciationSearch {
	constructor(target, lengths){
		this.levels = target.flatMap((syllable, source)=>syllable === null ? [] : [{
			source, options: syllableVariations(syllable).map(({u,c})=>({
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
