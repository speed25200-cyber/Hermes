class RateLimiter{
  constructor({capacity=10, intervalMs=2000}={}){this.q=[];this.n=0;this.cap=capacity;this.ms=intervalMs;setInterval(()=>{this.n=0;this._drain();},this.ms);}
  enqueue(fn){return new Promise((res,rej)=>{this.q.push({fn,res,rej});this._drain();});}
  _drain(){while(this.n<this.cap&&this.q.length){const t=this.q.shift();this.n++;Promise.resolve().then(t.fn).then(t.res,t.rej);}}
}
module.exports={RateLimiter};
