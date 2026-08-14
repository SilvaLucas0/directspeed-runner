import { getCampaign, patchState, nextLead, markLead, wasSent, recordSent, dailyCount, hourCount, recoverProcessing, getState } from './store.js';
import { InstagramSession } from './instagram.js';

const delay=ms=>new Promise(r=>setTimeout(r,ms));
const jitter=(n,p=.2)=>Math.max(1,Math.round(n*(1+(Math.random()*2-1)*p)));
const sessions=new Map();
export const controls=new Map();
export const getInstagram=userId=>{ if(!sessions.has(userId))sessions.set(userId,new InstagramSession(userId)); return sessions.get(userId); };

function messageFor(messages,sent,username){
  const active=messages.filter(m=>m?.enabled!==false && String(m?.message||'').trim()); if(!active.length) throw new Error('Configure pelo menos uma mensagem.');
  let cursor=sent; let chosen=active[0];
  for(const m of active){ const span=Math.max(1,Number(m.switchAfter)||10); if(cursor<span){chosen=m;break;} cursor-=span; chosen=m; }
  return {name:chosen.name||`MSG ${chosen.order||1}`,text:String(chosen.message).replaceAll('{user}',username)};
}
function untilHour(hour){ const d=new Date(); const next=new Date(d); next.setHours(hour,0,0,0); if(next<=d)next.setDate(next.getDate()+1); return next; }
function allowed(h1,h2){ const h=new Date().getHours(); return h1<=h2 ? h>=h1&&h<h2 : h>=h1||h<h2; }

export async function startRunner(userId,broadcast){
  if(controls.get(userId)?.running) return;
  const ctl={running:true,paused:false}; controls.set(userId,ctl); recoverProcessing(userId);
  patchState(userId,{current_state:'rodando',last_error:null}); broadcast(userId);
  const ig=getInstagram(userId); let errors=0;
  while(ctl.running){
    if(ctl.paused){ patchState(userId,{current_state:'pausado'}); broadcast(userId); await delay(500); continue; }
    const {settings,messages}=getCampaign(userId); const s=settings;
    const login=await ig.inspectLogin(); if(login.state!=='connected'){patchState(userId,{current_state:'erro',session_state:login.state,last_error:'Conecte o Instagram antes de iniciar.'});break;}
    const dc=dailyCount(userId), hc=hourCount(userId); patchState(userId,{sent_today:dc});
    if(dc>=Math.max(1,Number(s.dailyLimit)||40)){ const until=untilHour(Number(s.hourStart)||7); patchState(userId,{current_state:'pausa_diaria',pause_until:until.toISOString()});broadcast(userId); ctl.running=false;break; }
    if(hc>=Math.max(1,Number(s.maxPerHour)||20)){ const until=new Date(Date.now()+10*60*1000);patchState(userId,{current_state:'limite_hora',pause_until:until.toISOString()});broadcast(userId);await delay(60000);continue; }
    if(!allowed(Number(s.hourStart??7),Number(s.hourEnd??23))){ const until=untilHour(Number(s.hourStart)||7);patchState(userId,{current_state:'fora_horario',pause_until:until.toISOString()});broadcast(userId);ctl.running=false;break; }
    let state=getState(userId); let target=Number(state.cycle_target||0), processed=Number(state.cycle_processed||0);
    if(!target){target=jitter(Number(s.leadsPerCycle)||15,.2);patchState(userId,{cycle_target:target,cycle_processed:0});processed=0;}
    if(processed>=target){ const mins=jitter(Number(s.pauseMinutes)||60,.25), until=new Date(Date.now()+mins*60000); patchState(userId,{current_state:'pausa_ciclo',pause_until:until.toISOString(),cycle_processed:0,cycle_target:0});broadcast(userId); await delay(mins*60000); if(!ctl.running)break; patchState(userId,{current_state:'rodando',pause_until:null});continue; }
    const lead=nextLead(userId,s.order); if(!lead){patchState(userId,{current_state:'concluido',current_lead:null,next_action_at:null});broadcast(userId);ctl.running=false;break;}
    if(wasSent(userId,lead.username)){markLead(userId,lead.id,'sent',{templateUsed:'histórico'});continue;}
    let msg; try{msg=messageFor(messages,dc,lead.username);}catch(e){markLead(userId,lead.id,'error',{errorMessage:e.message});patchState(userId,{current_state:'erro',last_error:e.message});ctl.running=false;break;}
    patchState(userId,{current_state:'rodando',current_lead:lead.username,active_message:msg.name});broadcast(userId);
    try{
      const result=await ig.sendDM(lead.username,msg.text);
      if(result.status==='sent'){markLead(userId,lead.id,'sent',{templateUsed:msg.name});recordSent(userId,lead.username);errors=0;processed++;patchState(userId,{sent_today:dailyCount(userId),cycle_processed:processed,last_error:null});}
      else {markLead(userId,lead.id,'skipped',{templateUsed:msg.name,errorMessage:result.reason});errors++;}
    }catch(e){markLead(userId,lead.id,'error',{templateUsed:msg.name,errorMessage:e.message});errors++;patchState(userId,{last_error:e.message});}
    broadcast(userId);
    if(s.safeMode!==false && errors>=Math.max(2,Number(s.stopAfterErrors)||4)){patchState(userId,{current_state:'erro',last_error:`Parado após ${errors} erros seguidos.`});ctl.running=false;break;}
    const min=Math.max(1,Number(s.minDelay)||60),max=Math.max(min,Number(s.maxDelay)||180),seconds=Math.floor(min+Math.random()*(max-min+1)),next=new Date(Date.now()+seconds*1000);patchState(userId,{current_state:'aguardando',next_action_at:next.toISOString()});broadcast(userId);await delay(seconds*1000);patchState(userId,{next_action_at:null});
  }
  const final=getState(userId); if(!['concluido','erro','pausa_diaria','fora_horario'].includes(final.current_state))patchState(userId,{current_state:'parado',current_lead:null,next_action_at:null});broadcast(userId);
}
export function pauseRunner(userId){const c=controls.get(userId);if(c){c.paused=true;}patchState(userId,{current_state:'pausado'});}
export function resumeRunner(userId,broadcast){const c=controls.get(userId);if(c?.running){c.paused=false;patchState(userId,{current_state:'rodando'});broadcast(userId);return;}return startRunner(userId,broadcast);}
export function stopRunner(userId){const c=controls.get(userId);if(c){c.running=false;c.paused=false;}patchState(userId,{current_state:'parado',current_lead:null,next_action_at:null,pause_until:null});}
export function resetCycle(userId){patchState(userId,{cycle_processed:0,cycle_target:0,pause_until:null});}
