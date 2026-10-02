// Minimal DOM and canvas stub so the render modules can be loaded and
// exercised in node. The headless tools use it to catch runtime errors in
// drawing code, and to build PNGs, without needing a browser.
class Ctx2D {
  constructor(c){this.canvas=c;}
  createImageData(w,h){return {width:w,height:h,data:new Uint8ClampedArray(w*h*4)};}
  putImageData(){} drawImage(){} clearRect(){} fillRect(){} strokeRect(){}
  beginPath(){} moveTo(){} lineTo(){} arc(){} closePath(){} fill(){} stroke(){}
  save(){} restore(){} translate(){} scale(){} fillText(){} strokeText(){}
  setLineDash(){} measureText(){return {width:10};}
  // Gradients are objects with an addColorStop method; the drawing code only
  // ever builds one and assigns it to fillStyle.
  createRadialGradient(){return {addColorStop(){}};}
  createLinearGradient(){return {addColorStop(){}};}
  createPattern(){return null;}
  clip(){} rect(){} ellipse(){} quadraticCurveTo(){} bezierCurveTo(){}
  rotate(){} transform(){} setTransform(){} resetTransform(){}
}
class Element {
  constructor(tag){this.tagName=(tag||'div').toUpperCase();this.children=[];this.style={};this.dataset={};
    this.width=800;this.height=600;this._l={};this.classList={add(){},remove(){},toggle(){}};}
  getContext(){return this._ctx||(this._ctx=new Ctx2D(this));}
  getBoundingClientRect(){return {width:this.width,height:this.height,top:0,left:0};}
  addEventListener(k,f){this._l[k]=f;} removeEventListener(){}
  setPointerCapture(){}
  append(...k){for(const c of k) if(c) this.children.push(c);}
  setAttribute(k,v){this[k]=v;}
  set textContent(v){this._t=v;} get textContent(){return this._t;}
  set innerHTML(v){this.children.length=0;this._h=v;} get innerHTML(){return this._h||'';}
  get value(){return this._v;} set value(v){this._v=v;}
}
const byId = new Map();
for (const id of ['map','section','panel','clock','readout','legend','secW','secWv','secV','secVv',
                  'secQ','secM','secS','secL','secP','secC','secT','secDraw','secClear']) {
  byId.set(id, new Element(id.startsWith('sec')&&id.length>4?'input':'canvas'));
}
byId.get('secW').value='75'; byId.get('secV').value='26';
globalThis.document = {
  createElement:(t)=>new Element(t),
  createTextNode:(t)=>({nodeValue:t}),
  getElementById:(id)=>byId.get(id)||new Element('div'),
};
globalThis.window = { devicePixelRatio:1, addEventListener(){}, requestAnimationFrame(){} };
globalThis.requestAnimationFrame = () => 0;
globalThis.performance = performance;
export { byId };
