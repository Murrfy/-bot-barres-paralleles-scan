function n(value,fallback=0){
  const x=Number(value);
  return Number.isFinite(x)?x:fallback;
}
function upper(value){return String(value||'').trim().toUpperCase()}
function zenithId(value){return /^zth-[A-Za-z0-9._:-]{6,36}$/.test(String(value||''))}
function tradeKey(row){return String(row?.orderId??'')+':'+String(row?.id??row?.tradeId??'')}

export function managedOrderIndex(orders=[]){
  const ids=new Set();
  const byId=new Map();
  const symbols=new Set();
  for(const order of Array.isArray(orders)?orders:[]){
    const orderId=String(order?.orderId??'');
    const symbol=upper(order?.symbol);
    const clientOrderId=String(order?.clientOrderId||'');
    if(!orderId||!symbol||!zenithId(clientOrderId))continue;
    ids.add(orderId);
    symbols.add(symbol);
    byId.set(orderId,{symbol,clientOrderId,side:upper(order?.side),type:upper(order?.type||order?.origType),time:n(order?.time??order?.updateTime)});
  }
  return {ids,byId,symbols:[...symbols]};
}

function allocateCommission(row,ratio=1){
  const amount=n(row?.commission,0)*Math.max(0,Math.min(1,ratio));
  const asset=upper(row?.commissionAsset||row?.marginAsset);
  return {amount,asset};
}

function addCommission(cycle,commission){
  if(!(commission.amount!==0))return;
  if(!commission.asset||commission.asset==='USDT'){
    cycle.commissionUsdt+=commission.amount;
  }else{
    cycle.exactNet=false;
    cycle.otherCommissions.push({asset:commission.asset,amount:commission.amount});
  }
}

function newCycle(symbol,sign,row,openQty,openCommission,managed){
  const price=n(row?.price);
  return {
    symbol,
    sign,
    direction:sign>0?'LONG':'SHORT',
    openedAt:n(row?.time),
    closedAt:0,
    openQty,
    openQuote:price*openQty,
    closeQty:0,
    closeQuote:0,
    realizedPnl:0,
    commissionUsdt:0,
    funding:0,
    commissionRebate:0,
    exactNet:true,
    otherCommissions:[],
    managed:Boolean(managed),
    closeOrderIds:[],
  };
}

function closeReason(cycle,orderMeta){
  const last=cycle.closeOrderIds.at(-1);
  const client=String(orderMeta.get(last)?.clientOrderId||'');
  if(client.startsWith('zth-EXI-'))return 'VENTE LIMIT';
  if(client.startsWith('zth-ENT-'))return 'VENTE RÉELLE';
  if(client.startsWith('zth-PRO-'))return 'PROTECTION';
  if(client.startsWith('zth-MAX-'))return 'MAX-LOSS';
  return 'VENTE BINANCE';
}

export function buildClosedZenithTradeHistory({
  orders=[],
  trades=[],
  incomes=[],
  maxRows=80,
}={}){
  const orderIndex=managedOrderIndex(orders);
  const dedupe=new Set();
  const rows=(Array.isArray(trades)?trades:[])
    .filter(row=>{
      const key=tradeKey(row);
      if(!key||dedupe.has(key))return false;
      dedupe.add(key);
      return true;
    })
    .sort((a,b)=>n(a?.time)-n(b?.time)||n(a?.id)-n(b?.id));

  const active=new Map();
  const closed=[];

  function finalize(symbol,cycle,closedAt){
    cycle.closedAt=closedAt;
    const incomeRows=(Array.isArray(incomes)?incomes:[]).filter(row=>
      upper(row?.symbol)===symbol&&n(row?.time)>=cycle.openedAt&&n(row?.time)<=closedAt
    );
    cycle.funding=incomeRows
      .filter(row=>upper(row?.incomeType)==='FUNDING_FEE'&&upper(row?.asset)==='USDT')
      .reduce((sum,row)=>sum+n(row?.income),0);
    cycle.commissionRebate=incomeRows
      .filter(row=>upper(row?.incomeType)==='COMMISSION_REBATE'&&upper(row?.asset)==='USDT')
      .reduce((sum,row)=>sum+n(row?.income),0);
    const entryPrice=cycle.openQty>0?cycle.openQuote/cycle.openQty:0;
    const exitPrice=cycle.closeQty>0?cycle.closeQuote/cycle.closeQty:0;
    const netPnl=cycle.realizedPnl-cycle.commissionUsdt+cycle.funding+cycle.commissionRebate;
    if(cycle.managed&&entryPrice>0&&exitPrice>0){
      closed.push({
        symbol,
        direction:cycle.direction,
        openedAt:cycle.openedAt,
        closedAt,
        entryPrice,
        exitPrice,
        quantity:cycle.openQty,
        realizedPnl:cycle.realizedPnl,
        commission:cycle.commissionUsdt,
        funding:cycle.funding,
        commissionRebate:cycle.commissionRebate,
        netPnl,
        exactNet:cycle.exactNet,
        otherCommissions:cycle.otherCommissions,
        reason:closeReason(cycle,orderIndex.byId),
      });
    }
  }

  for(const row of rows){
    const symbol=upper(row?.symbol);
    const qty=n(row?.qty);
    const price=n(row?.price);
    const side=upper(row?.side);
    if(!symbol||!(qty>0)||!(price>0)||!['BUY','SELL'].includes(side))continue;
    let signed=side==='BUY'?qty:-qty;
    const orderId=String(row?.orderId??'');
    const managed=orderIndex.ids.has(orderId);
    let cycle=active.get(symbol)||null;

    if(!cycle){
      const commission=allocateCommission(row,1);
      cycle=newCycle(symbol,Math.sign(signed),row,Math.abs(signed),commission,managed);
      addCommission(cycle,commission);
      cycle.realizedPnl+=n(row?.realizedPnl,0);
      active.set(symbol,cycle);
      continue;
    }

    const positionSigned=cycle.sign*(cycle.openQty-cycle.closeQty);
    if(positionSigned===0||Math.sign(positionSigned)===Math.sign(signed)){
      const commission=allocateCommission(row,1);
      cycle.openQty+=Math.abs(signed);
      cycle.openQuote+=price*Math.abs(signed);
      cycle.managed=cycle.managed||managed;
      cycle.realizedPnl+=n(row?.realizedPnl,0);
      addCommission(cycle,commission);
      active.set(symbol,cycle);
      continue;
    }

    const liveQty=Math.abs(positionSigned);
    const closeQty=Math.min(liveQty,Math.abs(signed));
    const closeRatio=closeQty/Math.abs(signed);
    cycle.closeQty+=closeQty;
    cycle.closeQuote+=price*closeQty;
    cycle.realizedPnl+=n(row?.realizedPnl,0);
    cycle.managed=cycle.managed||managed;
    cycle.closeOrderIds.push(orderId);
    addCommission(cycle,allocateCommission(row,closeRatio));

    const remainder=Math.abs(signed)-closeQty;
    if(remainder<=1e-12){
      if(Math.abs(cycle.openQty-cycle.closeQty)<=1e-12){
        finalize(symbol,cycle,n(row?.time));
        active.delete(symbol);
      }else{
        active.set(symbol,cycle);
      }
      continue;
    }

    finalize(symbol,cycle,n(row?.time));
    const openRatio=remainder/Math.abs(signed);
    const next=newCycle(symbol,Math.sign(signed),row,remainder,allocateCommission(row,openRatio),managed);
    addCommission(next,allocateCommission(row,openRatio));
    active.set(symbol,next);
  }

  return closed
    .sort((a,b)=>b.closedAt-a.closedAt)
    .slice(0,Math.max(1,Math.min(200,Math.floor(n(maxRows,80)))));
}
