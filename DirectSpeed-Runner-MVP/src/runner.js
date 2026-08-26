import { getCampaign, patchState, nextLead, markLead, wasSent, recordSent, dailyCount, hourCount, recoverProcessing, getState, listResumableUsers } from './store.js';
import { InstagramSession } from './instagram.js';

const delay=ms=>new Promise(r=>setTimeout(r,ms));
const jitter=(n,p=.2)=>Math.max(1,Math.round(n*(1+(Math.random()*2-1)*p)));
// Espera fatiada: Stop e Pause passam a responder na hora, em vez de só quando o sono termina.
const waitWhile=async(ms,ctl)=>{ const end=Date.now()+ms; while(ctl.running&&Date.now()<end) await delay(Math.min(1000,end-Date.now())); };
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

export async function startRunner(userId,broadcast,opts={}){
  if(controls.get(userId)?.running) return;
  const ctl={running:true,paused:!!opts.paused}; controls.set(userId,ctl); recoverProcessing(userId);
  patchState(userId,{current_state:ctl.paused?'pausado':'rodando',last_error:null}); broadcast(userId);
  const ig=getInstagram(userId); let errors=0;
  while(ctl.running){
    if(ctl.paused){ patchState(userId,{current_state:'pausado'}); broadcast(userId); await delay(500); continue; }
    const {settings,messages}=getCampaign(userId); const s=settings;
    const login=await ig.inspectLogin(); if(login.state!=='connected'){patchState(userId,{current_state:'erro',session_state:login.state,last_error:'Conecte o Instagram antes de iniciar.'});break;}
    const dc=dailyCount(userId), hc=hourCount(userId); patchState(userId,{sent_today:dc});
    if(dc>=Math.max(1,Number(s.dailyLimit)||40)){ const until=untilHour(Number(s.hourStart)||7); patchState(userId,{current_state:'pausa_diaria',pause_until:until.toISOString()});broadcast(userId); ctl.running=false;break; }
    if(hc>=Math.max(1,Number(s.maxPerHour)||20)){ const until=new Date(Date.now()+10*60*1000);patchState(userId,{current_state:'limite_hora',pause_until:until.toISOString()});broadcast(userId);await waitWhile(60000,ctl);continue; }
    if(!allowed(Number(s.hourStart??7),Number(s.hourEnd??23))){ const until=untilHour(Number(s.hourStart)||7);patchState(userId,{current_state:'fora_horario',pause_until:until.toISOString()});broadcast(userId);ctl.running=false;break; }
    let state=getState(userId); let target=Number(state.cycle_target||0), processed=Number(state.cycle_processed||0);
    if(!target){target=jitter(Number(s.leadsPerCycle)||15,.2);patchState(userId,{cycle_target:target,cycle_processed:0});processed=0;}
    if(processed>=target){
      // Honra uma pausa já em curso: se o container reiniciou no meio dela, retoma o tempo restante
      // em vez de começar 60 minutos do zero — ou de sair enviando na hora.
      const pending=state.current_state==='pausa_ciclo'&&state.pause_until?new Date(state.pause_until).getTime():0;
      const until=pending>Date.now()?new Date(pending):new Date(Date.now()+jitter(Number(s.pauseMinutes)||60,.25)*60000);
      patchState(userId,{current_state:'pausa_ciclo',pause_until:until.toISOString()});broadcast(userId);
      await waitWhile(until.getTime()-Date.now(),ctl); if(!ctl.running)break;
      patchState(userId,{current_state:'rodando',pause_until:null,cycle_processed:0,cycle_target:0});continue;
    }
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
    const min=Math.max(1,Number(s.minDelay)||60),max=Math.max(min,Number(s.maxDelay)||180),seconds=Math.floor(min+Math.random()*(max-min+1)),next=new Date(Date.now()+seconds*1000);patchState(userId,{current_state:'aguardando',next_action_at:next.toISOString()});broadcast(userId);await waitWhile(seconds*1000,ctl);patchState(userId,{next_action_at:null});
  }
  const final=getState(userId); if(!['concluido','erro','pausa_diaria','fora_horario'].includes(final.current_state))patchState(userId,{current_state:'parado',current_lead:null,next_action_at:null});broadcast(userId);
}

// Chamado no boot: o container pode reiniciar a qualquer momento (redeploy, OOM, manutenção da
// Railway) e sem isto a fila morre em silêncio com o painel ainda mostrando "RODANDO".
export function resumeAll(broadcast){
  const rows=listResumableUsers();
  for(const row of rows){
    startRunner(row.user_id,broadcast,{paused:row.current_state==='pausado'})
      .catch(e=>patchState(row.user_id,{current_state:'erro',last_error:`Falha ao retomar após reinício: ${e.message}`}));
  }
  return rows.length;
}
export function pauseRunner(userId){const c=controls.get(userId);if(c){c.paused=true;}patchState(userId,{current_state:'pausado'});}
export function resumeRunner(userId,broadcast){const c=controls.get(userId);if(c?.running){c.paused=false;patchState(userId,{current_state:'rodando'});broadcast(userId);return;}return startRunner(userId,broadcast);}
export function stopRunner(userId){const c=controls.get(userId);if(c){c.running=false;c.paused=false;}patchState(userId,{current_state:'parado',current_lead:null,next_action_at:null,pause_until:null});}
export function resetCycle(userId){patchState(userId,{cycle_processed:0,cycle_target:0,pause_until:null});}
