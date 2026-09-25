function n(value,fallback=0){
  const x=Number(value);
  return Number.isFinite(x)?x:fallback;
}
function upper(value){return String(value??'').trim().toUpperCase()}
function orderKey(symbol,orderId){return upper(symbol)+':'+String(orderId??'')}
function signedAdd(target,asset,amount){
  const key=upper(asset)||'UNKNOWN';
  const value=n(amount,0);
  if(Math.abs(value)<=1e-18)return;
  target[key]=n(target[key],0)+value;
}
function signedAddScaled(target,asset,amount,ratio){
  const r=Math.max(0,Math.min(1,n(ratio,0)));
  signedAdd(target,asset,n(amount,0)*r);
}
function zenithEntryClientId(value){
  return /^zth-ENT-[A-Za-z0-9._:-]+$/.test(String(value||''));
}
function createCycle({symbol,direction,time,orderId,clientOrderId,qty,price,commission,commissionAsset}){
  const fees={};
  signedAdd(fees,commissionAsset,commission);
  return {
    symbol,
    direction,
    openedAt:time,
    closedAt:0,
    entryQty:qty,
    entryNotional:qty*price,
    exitQty:0,
    exitNotional:0,
    realizedPnl:0,
    fees,
    openingOrderId:String(orderId||''),
    openingClientOrderId:String(clientOrderId||''),
    closingOrderId:'',
    closingClientOrderId:'',
    zenithOwned:zenithEntryClientId(clientOrderId),
  };
}
function addOpen(cycle,{qty,price,commission,commissionAsset}){
  cycle.entryQty+=qty;
  cycle.entryNotional+=qty*price;
  signedAdd(cycle.fees,commissionAsset,commission);
}
function finalizeCycle(cycle,fundingRows){
  const fundingByAsset={};
  for(const row of Array.isArray(fundingRows)?fundingRows:[]){
    if(upper(row?.symbol)!==cycle.symbol)continue;
    const t=n(row?.time,0);
    if(!(t>=cycle.openedAt&&t<=cycle.closedAt))continue;
    if(upper(row?.incomeType)!=='FUNDING_FEE')continue;
    signedAdd(fundingByAsset,row?.asset,row?.income);
  }
  const entryPrice=cycle.entryQty>0?cycle.entryNotional/cycle.entryQty:0;
  const exitPrice=cycle.exitQty>0?cycle.exitNotional/cycle.exitQty:0;
  const commissionUsdt=n(cycle.fees.USDT,0);
  const fundingUsdt=n(fundingByAsset.USDT,0);
  const nonUsdtCommission=Object.entries(cycle.fees)
    .filter(([asset,amount])=>asset!=='USDT'&&Math.abs(n(amount))>1e-18);
  const nonUsdtFunding=Object.entries(fundingByAsset)
    .filter(([asset,amount])=>asset!=='USDT'&&Math.abs(n(amount))>1e-18);
  const exactNetUsdt=nonUsdtCommission.length===0&&nonUsdtFunding.length===0;
  return {
    version:2,
    id:[cycle.symbol,cycle.direction,cycle.openedAt,cycle.closedAt,cycle.openingOrderId].join(':'),
    symbol:cycle.symbol,
    direction:cycle.direction,
    openedAt:cycle.openedAt,
    closedAt:cycle.closedAt,
    entryPrice,
    exitPrice,
    closedQuantity:cycle.exitQty,
    grossRealizedPnl:cycle.realizedPnl,
    commissionUsdt,
    fundingUsdt,
    netUsdt:exactNetUsdt?cycle.realizedPnl-commissionUsdt+fundingUsdt:null,
    exactNetUsdt,
    feesByAsset:cycle.fees,
    fundingByAsset,
    openingOrderId:cycle.openingOrderId,
    openingClientOrderId:cycle.openingClientOrderId,
    closingOrderId:cycle.closingOrderId,
    closingClientOrderId:cycle.closingClientOrderId,
  };
}

export function buildOrderClientIdMap(orders=[]){
  const map=new Map();
  for(const order of Array.isArray(orders)?orders:[]){
    const symbol=upper(order?.symbol),orderId=String(order?.orderId??'');
    if(!symbol||!orderId)continue;
    map.set(orderKey(symbol,orderId),String(order?.clientOrderId||''));
  }
  return map;
}

export function buildZenithClosedTradeHistory({trades=[],orders=[],funding=[]}={}){
  const orderIds=buildOrderClientIdMap(orders);
  const sorted=(Array.isArray(trades)?trades:[])
    .map(row=>({
      symbol:upper(row?.symbol),
      positionSide:upper(row?.positionSide||'BOTH'),
      side:upper(row?.side),
      qty:Math.abs(n(row?.qty??row?.quantity,0)),
      price:n(row?.price,0),
      realizedPnl:n(row?.realizedPnl,0),
      commission:n(row?.commission,0),
      commissionAsset:upper(row?.commissionAsset),
      time:n(row?.time,0),
      orderId:String(row?.orderId??''),
      tradeId:String(row?.id??row?.tradeId??''),
    }))
    .filter(row=>row.symbol&&row.positionSide==='BOTH'&&['BUY','SELL'].includes(row.side)&&row.qty>0&&row.price>0&&row.time>0)
    .sort((a,b)=>a.time-b.time||n(a.tradeId)-n(b.tradeId));

  const states=new Map();
  const closed=[];
  for(const trade of sorted){
    const delta=(trade.side==='BUY'?1:-1)*trade.qty;
    const clientOrderId=orderIds.get(orderKey(trade.symbol,trade.orderId))||'';
    const state=states.get(trade.symbol)||{qty:0,cycle:null};
    const before=state.qty;

    if(Math.abs(before)<=1e-12||Math.sign(before)===Math.sign(delta)){
      if(Math.abs(before)<=1e-12){
        state.cycle=createCycle({
          symbol:trade.symbol,
          direction:delta>0?'LONG':'SHORT',
          time:trade.time,
          orderId:trade.orderId,
          clientOrderId,
          qty:trade.qty,
          price:trade.price,
          commission:trade.commission,
          commissionAsset:trade.commissionAsset,
        });
      }else if(state.cycle){
        addOpen(state.cycle,{
          qty:trade.qty,
          price:trade.price,
          commission:trade.commission,
          commissionAsset:trade.commissionAsset,
        });
      }
      state.qty=before+delta;
      states.set(trade.symbol,state);
      continue;
    }

    const closeQty=Math.min(Math.abs(before),trade.qty);
    const ratio=closeQty/trade.qty;
    if(state.cycle){
      state.cycle.exitQty+=closeQty;
      state.cycle.exitNotional+=closeQty*trade.price;
      state.cycle.realizedPnl+=trade.realizedPnl;
      signedAddScaled(state.cycle.fees,trade.commissionAsset,trade.commission,ratio);
      state.cycle.closingOrderId=trade.orderId;
      state.cycle.closingClientOrderId=clientOrderId;
    }

    const after=before+delta;
    const crossed=Math.abs(after)<=1e-12||Math.sign(after)!==Math.sign(before);
    if(crossed&&state.cycle){
      state.cycle.closedAt=trade.time;
      if(state.cycle.zenithOwned)closed.push(finalizeCycle(state.cycle,funding));
      state.cycle=null;
    }

    if(Math.abs(after)>1e-12&&Math.sign(after)!==Math.sign(before)){
      const openQty=Math.abs(after);
      const openRatio=openQty/trade.qty;
      state.cycle=createCycle({
        symbol:trade.symbol,
        direction:after>0?'LONG':'SHORT',
        time:trade.time,
        orderId:trade.orderId,
        clientOrderId,
        qty:openQty,
        price:trade.price,
        commission:trade.commission*openRatio,
        commissionAsset:trade.commissionAsset,
      });
    }
    state.qty=Math.abs(after)<=1e-12?0:after;
    states.set(trade.symbol,state);
  }

  return closed.sort((a,b)=>b.closedAt-a.closedAt);
}

export function mergeTradeHistory(existing=[],fresh=[],limit=500){
  const byId=new Map();
  for(const row of [...(Array.isArray(existing)?existing:[]),...(Array.isArray(fresh)?fresh:[])]){
    if(row&&row.id)byId.set(String(row.id),row);
  }
  return [...byId.values()]
    .sort((a,b)=>n(b.closedAt)-n(a.closedAt))
    .slice(0,Math.max(1,Math.min(1000,n(limit,500))));
}
