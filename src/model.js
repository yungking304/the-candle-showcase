export const contracts = {
  MES:{name:'Micro E-mini S&P 500',point:5,tick:0.25}, MNQ:{name:'Micro E-mini Nasdaq-100',point:2,tick:0.25},
  MGC:{name:'Micro Gold',point:10,tick:0.1}, ES:{name:'E-mini S&P 500',point:50,tick:0.25},
  NQ:{name:'E-mini Nasdaq-100',point:20,tick:0.25}, GC:{name:'Gold',point:100,tick:0.1}
};
export function calculate(symbol,direction,quantity,movement,fees){
 const c=contracts[symbol];
 if(!c || !['long','short'].includes(direction))throw Error('Choose a valid contract and direction.');
 if(!Number.isInteger(quantity)||quantity<1||quantity>100)throw Error('Enter a whole number of contracts from 1 to 100.');
 if(!Number.isFinite(movement)||Math.abs(movement)>1000)throw Error('Enter a price movement between −1,000 and +1,000 points.');
 if(Math.abs(movement/c.tick-Math.round(movement/c.tick))>0.000001)throw Error('Use '+c.tick+'-point increments for '+symbol+'.');
 if(!Number.isFinite(fees)||fees<0||fees>1000||Math.abs(fees*100-Math.round(fees*100))>0.000001)throw Error('Enter fees from $0 to $1,000, using no more than two decimal places.');
 const gross=Math.round(movement*c.point*quantity*(direction==='long'?1:-1)*100)/100;
 const totalFees=Math.round(fees*quantity*100)/100;
 return {gross,totalFees,net:Math.round((gross-totalFees)*100)/100,ticks:Math.round(movement/c.tick)};
}
export const quizzes=[
 [
  {q:'What are you trading when you buy a futures contract?',options:['A share of ownership in a company','A standardized contract tied to an underlying market','An investment with a guaranteed return'],correct:1,explain:'A futures contract has exchange-defined terms for a particular underlying market and expiration. It is not company ownership.'},
  {q:'Which description fits an option buyer?',options:['They purchase a right, without an obligation to exercise it','They must take delivery of every contract','They own part of the company just by buying an option'],correct:0,explain:'An option buyer pays a premium for a right to buy or sell at a specified strike price under the contract terms. That right can expire worthless.'},
  {q:'What does futures margin tell you?',options:['The most you can possibly lose','The full value of the contract','The funds required to support the position'],correct:2,explain:'Margin supports a leveraged position. It is not a maximum loss. Losses can exceed the initial amount deposited.'}
 ],
 [
  {q:'You buy 1 MES contract and close it 10 points higher. At $5 per point, what is the gross result?',options:['+$50','+$5','−$50'],correct:0,explain:'10 points × $5 per point × 1 contract = $50 gross profit. Fees reduce the amount you keep.'},
  {q:'You are short 2 MGC contracts. Price rises 3 points. At $10 per point, what is the gross result?',options:['+$60','−$6','−$60'],correct:2,explain:'A short loses when price rises: −3 × $10 × 2 = −$60 before fees. For gold, 3 points is a $3.00/oz move.'},
  {q:'MES moves by one tick (0.25 points). How much is that for 1 contract?',options:['$5.00','$1.25','$0.25'],correct:1,explain:'One tick is smaller than one full point: 0.25 × $5 = $1.25. Four MES ticks make one point.'}
 ],
 [
  {q:'A series of higher swing highs and higher swing lows usually describes what?',options:['A guaranteed winning buy signal','An uptrend','A downtrend'],correct:1,explain:'Those swings describe an uptrend. They summarize what price has done; they cannot guarantee what comes next.'},
  {q:'Price breaks above a resistance area. What should a beginner understand?',options:['The breakout can fail and price can return below the area','Price must keep rising','A stop order is no longer useful'],correct:0,explain:'Breakouts can fail. Context, a planned invalidation level, and a defined amount at risk still matter.'},
  {q:'Before placing a practice trade, what should you define?',options:['Only the amount you hope to earn','The biggest contract size you can access','Your setup, entry, invalidation level, and planned dollar risk'],correct:2,explain:'Plan the trade before entering. A stop helps manage risk, but actual fills can be worse than the stop price during fast moves.'}
 ]
];
