// Drawing helpers for whiteboard lessons. Pure functions: safe to import in the browser and in Node tools.
// Board is 800 × 450. Colors: ink, g (up), r (The Candle's deep amber: down / caution), b (blue), grey,
// plus light zone fills gz, az, bz.
export const COLORS={ink:'#22261C',g:'#2E8B46',r:'#B95F0B',b:'#2B66AD',grey:'#727866',gz:'#CFE7C8',az:'#F6DDBA',bz:'#D3E0F2'};
export const T=(text,x,y,s=30,c='ink',d)=>({k:'t',text,x,y,s,c,d:d||Math.max(500,text.length*42)});
export const P=(p,c='ink',w=4,d=700,f)=>({k:'p',p,c,w,d,...(f?{f}:{})});
export const dot=(x,y,c)=>P(`M${x},${y} m-8,0 a8,8 0 1,0 16,0 a8,8 0 1,0 -16,0`,c,4,300,c);
export const ring=(x,y,r,c,d=800)=>P(`M${x},${y} m-${r},0 a${r},${r} 0 1,0 ${2*r},0 a${r},${r} 0 1,0 -${2*r},0`,c,3,d);
export const box=(x,y,w,h,c,d=600)=>P(`M${x},${y} h${w} v${h} h-${w} Z`,c,3,d);
// A shaded price zone (draw it before the candles so they sit on top).
export const zone=(x,y,w,h,c='gz',d=500)=>P(`M${x},${y} h${w} v${h} h-${w} Z`,c,2,d,c);
// Straight line and arrow (head at the end point).
export const line=(x1,y1,x2,y2,c='ink',w=3,d=500)=>P(`M${x1},${y1} L${x2},${y2}`,c,w,d);
export function arrow(x1,y1,x2,y2,c='ink',w=3,d=500){const a=Math.atan2(y2-y1,x2-x1),h=14,l=a+Math.PI*0.82,r=a-Math.PI*0.82;
  const p=(t)=>`${(x2+h*Math.cos(t)).toFixed(1)},${(y2+h*Math.sin(t)).toFixed(1)}`;return P(`M${x1},${y1} L${x2},${y2} M${p(l)} L${x2},${y2} L${p(r)}`,c,w,d);}
// One candle at x. o, c, h, l are y positions (smaller y = higher price).
export function candle(x,o,c,h,l,w=26,d=380,col){const top=Math.min(o,c),bot=Math.max(o,c),k=col||(c<o?'g':c>o?'r':'grey'),hw=w/2;
  return P(`M${x},${h} V${top} M${x-hw},${top} h${w} v${Math.max(bot-top,3)} h${-w} Z M${x},${bot} V${l}`,k,3,d,k);}
// A row of candles: bars = [[o,c,h,l],...], starting at x0, spaced by step.
export const candles=(bars,x0=120,step=60,w=26,d=320)=>bars.map((b,i)=>candle(x0+i*step,b[0],b[1],b[2],b[3],w,d));
// Price and time axes for a chart area.
export const axes=(x=70,y=395,right=740,top=95,d=700)=>P(`M${x},${top} V${y} H${right}`,'ink',3,d);
// Polyline through points [[x,y],...].
export const path=(pts,c='b',w=4,d=900)=>P('M'+pts.map(p=>p.join(',')).join(' L'),c,w,d);
