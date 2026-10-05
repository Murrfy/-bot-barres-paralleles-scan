/*
================================================================================
⛔⛔⛔  BLOC 4 VERROUILLÉ — HISTORIQUE RÉEL / GAINS-PERTES BINANCE  ⛔⛔⛔

        NE TOUCHEZ PAS À CE PUTAIN DE BLOC SANS L'ACCORD EXPLICITE DE WALTER.

Source de vérité : fills Binance réels, prix moyens réels, realized PnL, commissions
signées/rebates et funding. Une fermeture en plusieurs morceaux reste UN seul trade.
Une fermeture manuelle Binance d'une position ouverte par Zenith reste historisée.
Les positions non ouvertes par Zenith restent exclues.
Ne jamais inventer un net USDT si frais/funding sont dans un autre actif.
AUCUNE MODIFICATION, RÉÉCRITURE, SIMPLIFICATION, DÉPLACEMENT OU "AMÉLIORATION"
SANS L'ACCORD EXPLICITE DE WALTER ET SANS REPASSER LES TESTS DU BLOC 4.
================================================================================
*/
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
function tradeIdentity(row){return [upper(row?.symbol),String(row?.id??row?.tradeId??''),String(row?.orderId??''),String(row?.time??'')].join(':')}
function fundingIdentity(row){return [upper(row?.incomeType),String(row?.tranId??row?.tradeId??''),upper(row?.symbol),String(row?.time??'')].join(':')}
function createCycle({symbol,direction,time,orderId,clientOrderId,qty,price,commission,commissionAsset,tradeKey=''}){
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
    processedTradeKeys:tradeKey?[tradeKey]:[],
    fundingRows:[],
  };
}
function addOpen(cycle,{qty,price,commission,commissionAsset,tradeKey=''}){
  cycle.entryQty+=qty;
  cycle.entryNotional+=qty*price;
  signedAdd(cycle.fees,commissionAsset,commission);
  if(tradeKey&&!cycle.processedTradeKeys.includes(tradeKey))cycle.processedTradeKeys.push(tradeKey);
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

export function advanceZenithTradeHistory({trades=[],orders=[],funding=[]}={},openCycles=[]){
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
      tradeKey:tradeIdentity(row),
    }))
    .filter(row=>row.symbol&&row.positionSide==='BOTH'&&['BUY','SELL'].includes(row.side)&&row.qty>0&&row.price>0&&row.time>0)
    .sort((a,b)=>a.time-b.time||n(a.tradeId)-n(b.tradeId));

  const states=new Map();
  for(const saved of Array.isArray(openCycles)?openCycles:[]){
    if(!saved?.zenithOwned||!saved?.symbol||!saved?.direction)continue;
    const cycle=JSON.parse(JSON.stringify(saved));
    cycle.processedTradeKeys=Array.isArray(cycle.processedTradeKeys)?cycle.processedTradeKeys:[];
    cycle.fundingRows=Array.isArray(cycle.fundingRows)?cycle.fundingRows:[];
    const qty=Math.max(0,n(cycle.entryQty)-n(cycle.exitQty));
    if(qty>1e-12)states.set(upper(cycle.symbol),{qty:cycle.direction==='LONG'?qty:-qty,cycle});
  }

  const freshFunding=Array.isArray(funding)?funding:[];
  const closed=[];
  for(const trade of sorted){
    const delta=(trade.side==='BUY'?1:-1)*trade.qty;
    const clientOrderId=orderIds.get(orderKey(trade.symbol,trade.orderId))||'';
    const state=states.get(trade.symbol)||{qty:0,cycle:null};
    if(state.cycle?.processedTradeKeys?.includes(trade.tradeKey))continue;
    const before=state.qty;

    if(Math.abs(before)<=1e-12||Math.sign(before)===Math.sign(delta)){
      if(Math.abs(before)<=1e-12){
        state.cycle=createCycle({
          symbol:trade.symbol,direction:delta>0?'LONG':'SHORT',time:trade.time,
          orderId:trade.orderId,clientOrderId,qty:trade.qty,price:trade.price,
          commission:trade.commission,commissionAsset:trade.commissionAsset,tradeKey:trade.tradeKey,
        });
      }else if(state.cycle){
        addOpen(state.cycle,{qty:trade.qty,price:trade.price,commission:trade.commission,commissionAsset:trade.commissionAsset,tradeKey:trade.tradeKey});
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
      if(!state.cycle.processedTradeKeys.includes(trade.tradeKey))state.cycle.processedTradeKeys.push(trade.tradeKey);
    }

    const after=before+delta;
    const crossed=Math.abs(after)<=1e-12||Math.sign(after)!==Math.sign(before);
    if(crossed&&state.cycle){
      state.cycle.closedAt=trade.time;
      if(state.cycle.zenithOwned){
        const fundingById=new Map((state.cycle.fundingRows||[]).map(row=>[fundingIdentity(row),row]));
        for(const row of freshFunding)fundingById.set(fundingIdentity(row),row);
        closed.push(finalizeCycle(state.cycle,[...fundingById.values()]));
      }
      state.cycle=null;
    }

    if(Math.abs(after)>1e-12&&Math.sign(after)!==Math.sign(before)){
      const openQty=Math.abs(after),openRatio=openQty/trade.qty;
      state.cycle=createCycle({
        symbol:trade.symbol,direction:after>0?'LONG':'SHORT',time:trade.time,
        orderId:trade.orderId,clientOrderId,qty:openQty,price:trade.price,
        commission:trade.commission*openRatio,commissionAsset:trade.commissionAsset,tradeKey:trade.tradeKey,
      });
    }
    state.qty=Math.abs(after)<=1e-12?0:after;
    states.set(trade.symbol,state);
  }

  const open=[];
  for(const state of states.values()){
    const cycle=state?.cycle;
    if(!cycle?.zenithOwned||Math.abs(n(state.qty))<=1e-12)continue;
    const byId=new Map((cycle.fundingRows||[]).map(row=>[fundingIdentity(row),row]));
    for(const row of freshFunding){
      if(upper(row?.symbol)!==cycle.symbol||upper(row?.incomeType)!=='FUNDING_FEE')continue;
      const t=n(row?.time,0);
      if(t<cycle.openedAt)continue;
      byId.set(fundingIdentity(row),row);
    }
    cycle.fundingRows=[...byId.values()];
    open.push(cycle);
  }
  return {closed:closed.sort((a,b)=>b.closedAt-a.closedAt),openCycles:open};
}

export function buildZenithClosedTradeHistory(input={}){
  return advanceZenithTradeHistory(input,[]).closed;
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
