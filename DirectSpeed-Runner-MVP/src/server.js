import http from 'node:http';
import express from 'express';
import cors from 'cors';
import jwt from 'jsonwebtoken';
import { WebSocketServer } from 'ws';
import { createClient } from '@base44/sdk';
import { ensureUser, getState, patchState, getCampaign, saveCampaign, addLeads, listLeads, clearPending, resetQueue } from './store.js';
import { getInstagram, startRunner, pauseRunner, resumeRunner, stopRunner, resetCycle, resumeAll } from './runner.js';

const app=express(); const server=http.createServer(app); const wss=new WebSocketServer({server,path:'/ws'});
const PORT=Number(process.env.PORT||8787), APP_ID=process.env.BASE44_APP_ID, SECRET=process.env.JWT_SECRET;
if(!APP_ID||!SECRET) throw new Error('BASE44_APP_ID e JWT_SECRET são obrigatórios.');
const origins=String(process.env.ALLOWED_ORIGINS||'').split(',').map(x=>x.trim()).filter(Boolean);
app.use(cors({origin:(origin,cb)=>!origin||!origins.length||origins.includes(origin)?cb(null,true):cb(new Error('Origem não permitida'))})); app.use(express.json({limit:'2mb'}));
const sockets=new Map();
function sign(user){return jwt.sign({sub:user.id,email:user.email},SECRET,{expiresIn:'30d'});} function verify(t){return jwt.verify(t,SECRET);}
function broadcast(userId){const data=JSON.stringify({type:'state',data:getState(userId)});for(const ws of sockets.get(userId)||[])if(ws.readyState===1)ws.send(data);}
function auth(req,res,next){try{const t=(req.headers.authorization||'').replace(/^Bearer\s+/i,'');const p=verify(t);req.user={id:p.sub,email:p.email};ensureUser(req.user);next();}catch{res.status(401).json({error:'Sessão do Runner inválida.'});}}
app.get('/health',(_q,r)=>r.json({ok:true,service:'directspeed-runner',version:'0.1.0'}));
app.post('/api/auth/exchange',async(req,res)=>{try{const baseToken=(req.headers.authorization||'').replace(/^Bearer\s+/i,'');if(!baseToken)return res.status(401).json({error:'Token Base44 ausente.'});console.log('auth/exchange tentativa: appId='+APP_ID+' tokenLen='+baseToken.length+' tokenStart='+baseToken.slice(0,12));const b=createClient({appId:APP_ID,token:baseToken});const user=await b.auth.me();ensureUser(user);res.json({token:sign(user),user:{id:user.id,email:user.email}});}catch(e){console.error('auth/exchange falhou:',e.status||e.response?.status||'',e.message,JSON.stringify(e.response?.data||e.data||''));res.status(401).json({error:'Não foi possível validar sua conta DirectSpeed.',detail:e.message});}});
app.get('/api/state',auth,(q,r)=>r.json(getState(q.user.id)));
app.get('/api/campaign',auth,(q,r)=>r.json(getCampaign(q.user.id)));
app.put('/api/campaign',auth,(q,r)=>{const out=saveCampaign(q.user.id,q.body||{});broadcast(q.user.id);r.json(out);});
app.get('/api/leads',auth,(q,r)=>r.json({items:listLeads(q.user.id,{status:q.query.status,limit:q.query.limit,offset:q.query.offset}),state:getState(q.user.id)}));
app.post('/api/leads',auth,(q,r)=>{const raw=Array.isArray(q.body?.usernames)?q.body.usernames:[];const items=[...new Set(raw.map(x=>String(x).trim().replace(/^@/,'').toLowerCase()).filter(x=>/^[a-z0-9._]{1,30}$/.test(x)))];const added=addLeads(q.user.id,items);broadcast(q.user.id);r.json({added,state:getState(q.user.id)});});
app.delete('/api/leads/pending',auth,(q,r)=>{const removed=clearPending(q.user.id);broadcast(q.user.id);r.json({removed});});
app.post('/api/leads/reset',auth,(q,r)=>{resetQueue(q.user.id);broadcast(q.user.id);r.json({ok:true});});
app.post('/api/instagram/login',auth,async(q,r)=>{try{patchState(q.user.id,{status:'starting',session_state:'login_required'});const result=await getInstagram(q.user.id).login(String(q.body?.username||''),String(q.body?.password||''));patchState(q.user.id,{status:'online',session_state:result.state,instagram_username:result.state==='connected'?String(q.body.username):null,last_error:null});broadcast(q.user.id);r.json(result);}catch(e){patchState(q.user.id,{status:'error',last_error:e.message});broadcast(q.user.id);r.status(400).json({error:e.message});}});
app.post('/api/instagram/2fa',auth,async(q,r)=>{try{const ig=getInstagram(q.user.id);const result=await ig.submitTwoFactor(String(q.body?.code||''));const patch={status:'online',session_state:result.state,last_error:null};if(result.state==='connected'&&ig.lastUsername)patch.instagram_username=ig.lastUsername;patchState(q.user.id,patch);broadcast(q.user.id);r.json(result);}catch(e){r.status(400).json({error:e.message});}});
app.get('/api/instagram/status',auth,async(q,r)=>{const result=await getInstagram(q.user.id).inspectLogin();patchState(q.user.id,{status:'online',session_state:result.state});broadcast(q.user.id);r.json(result);});
// Diagnóstico: mostra a tela real do Chromium na nuvem (login, código, checkpoint).
app.get('/api/instagram/screenshot',auth,async(q,r)=>{try{const shot=await getInstagram(q.user.id).screenshot();const state=await getInstagram(q.user.id).inspectLogin();r.json({...shot,state:state.state});}catch(e){r.status(500).json({error:e.message});}});
app.post('/api/control/start',auth,(q,r)=>{startRunner(q.user.id,broadcast).catch(e=>patchState(q.user.id,{current_state:'erro',last_error:e.message}));r.json({ok:true});});
app.post('/api/control/pause',auth,(q,r)=>{pauseRunner(q.user.id);broadcast(q.user.id);r.json({ok:true});});
app.post('/api/control/resume',auth,(q,r)=>{resumeRunner(q.user.id,broadcast);broadcast(q.user.id);r.json({ok:true});});
app.post('/api/control/stop',auth,(q,r)=>{stopRunner(q.user.id);broadcast(q.user.id);r.json({ok:true});});
app.post('/api/control/reset-cycle',auth,(q,r)=>{resetCycle(q.user.id);broadcast(q.user.id);r.json({ok:true});});
wss.on('connection',(ws,req)=>{try{const u=new URL(req.url,'http://localhost');const p=verify(u.searchParams.get('token'));const id=p.sub;if(!sockets.has(id))sockets.set(id,new Set());sockets.get(id).add(ws);ensureUser({id,email:p.email});ws.send(JSON.stringify({type:'state',data:getState(id)}));ws.on('close',()=>sockets.get(id)?.delete(ws));}catch{ws.close(1008,'unauthorized');}});
server.listen(PORT,()=>{console.log(`DirectSpeed Runner ouvindo em :${PORT}`);const retomadas=resumeAll(broadcast);if(retomadas)console.log(`Retomando ${retomadas} fila(s) interrompida(s) pelo reinício.`);});
