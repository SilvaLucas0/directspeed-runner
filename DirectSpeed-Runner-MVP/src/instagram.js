import fs from 'node:fs';
import path from 'node:path';
import { chromium } from 'playwright';

const CODE_INPUT = 'input[name="verificationCode"], input[name="security_code"], input[autocomplete="one-time-code"]';
const LOGGED = 'a[href="/direct/inbox/"], svg[aria-label="Direct"], a[href*="/accounts/edit/"], svg[aria-label="Página inicial"], a[href="/explore/"]';
const SEND_CODE = /enviar c[óo]digo|enviar por sms|receber c[óo]digo|send( security)? code|este foi eu|fui eu|was me|outra forma|try another way|continuar|continue/i;
const DISMISS = /agora n[ãa]o|not now|dispensar|mais tarde/i;

export class InstagramSession {
  constructor(userId) { this.userId=userId; this.context=null; this.page=null; this.lastUsername=null; }
  async ensure() {
    if (this.context) return;
    const root=process.env.DATA_DIR||'./data'; const dir=path.join(root,'browser',this.userId); fs.mkdirSync(dir,{recursive:true});
    this.context=await chromium.launchPersistentContext(dir,{
      headless:String(process.env.HEADLESS||'true')!=='false',
      viewport:{width:1280,height:900},
      locale:'pt-BR',
      timezoneId:process.env.TIMEZONE||'America/Sao_Paulo',
      args:['--disable-blink-features=AutomationControlled']
    });
    this.page=this.context.pages()[0] || await this.context.newPage();
  }
  async count(selectorOrLocator) {
    const locator = typeof selectorOrLocator === 'string' ? this.page.locator(selectorOrLocator) : selectorOrLocator;
    return await locator.count().catch(()=>0);
  }
  // Detecção pura: nunca clica em nada. O runner chama isto a cada volta do loop.
  async inspectLogin() {
    await this.ensure(); const url=this.page.url();
    // Campo de código vem antes da URL: o Instagram pede código dentro de /challenge também,
    // e nesse caso o usuário CONSEGUE resolver pelo celular — não é um checkpoint sem saída.
    if (await this.count(CODE_INPUT)) return {state:'two_factor',url};
    if (url.includes('/two_factor')) return {state:'two_factor',url};
    if (url.includes('/challenge') || url.includes('/checkpoint') || url.includes('/suspended')) return {state:'checkpoint',url};
    if (url.includes('/accounts/login')) return {state:'login_required',url};
    return await this.count(LOGGED) ? {state:'connected',url} : {state:'login_required',url};
  }
  // Fecha "Salvar informações de login?" / "Ativar notificações", que escondem os marcadores de logado.
  async dismissDialogs() {
    for (let i=0;i<2;i++) {
      const button=this.page.getByRole('button',{name:DISMISS}).first();
      if (!await this.count(button)) return;
      await button.click({timeout:3000}).catch(()=>{});
      await this.page.waitForTimeout(1200);
    }
  }
  // Na tela de verificação o Instagram costuma exigir um clique ("Enviar código", "Este fui eu")
  // antes de mostrar o campo. Sem isso o login parava aqui achando que era checkpoint.
  async revealCodeInput() {
    for (let i=0;i<2;i++) {
      if (await this.count(CODE_INPUT)) return true;
      const url=this.page.url();
      if (!url.includes('/challenge') && !url.includes('/checkpoint') && !url.includes('/two_factor')) return false;
      const button=this.page.getByRole('button',{name:SEND_CODE}).first();
      const link=this.page.getByRole('link',{name:SEND_CODE}).first();
      const target=await this.count(button) ? button : (await this.count(link) ? link : null);
      if (!target) return await this.count(CODE_INPUT) > 0;
      await target.click({timeout:5000}).catch(()=>{});
      await this.page.waitForTimeout(4000);
    }
    return await this.count(CODE_INPUT) > 0;
  }
  async login(username,password) {
    await this.ensure(); this.lastUsername=username;
    await this.page.goto('https://www.instagram.com/accounts/login/',{waitUntil:'domcontentloaded',timeout:45000});
    await this.page.locator('input[name="username"]').fill(username);
    await this.page.locator('input[name="password"]').fill(password);
    await Promise.allSettled([this.page.waitForLoadState('domcontentloaded',{timeout:20000}),this.page.locator('button[type="submit"]').click()]);
    await this.page.waitForTimeout(5000);
    await this.revealCodeInput();
    await this.dismissDialogs();
    return this.inspectLogin();
  }
  async submitTwoFactor(code){
    await this.ensure();
    if (!await this.count(CODE_INPUT)) await this.revealCodeInput();
    const input=this.page.locator(CODE_INPUT).first();
    if(!await this.count(input)) throw new Error('Campo de verificação não encontrado. Peça um novo código e confira a tela pelo screenshot.');
    await input.fill(String(code).trim());
    const button=this.page.getByRole('button',{name:/confirmar|confirm|avançar|next|enviar|submit|continuar|continue/i}).first();
    if(await this.count(button)) await button.click({timeout:5000}).catch(()=>{}); else await input.press('Enter');
    await this.page.waitForTimeout(6000);
    await this.dismissDialogs();
    return this.inspectLogin();
  }
  // Diagnóstico: ver a tela real do Chromium na nuvem, e base para o relay de checkpoint.
  async screenshot(){
    await this.ensure();
    const buffer=await this.page.screenshot({type:'png'});
    const title=await this.page.title().catch(()=>'');
    return {url:this.page.url(),title,image:`data:image/png;base64,${buffer.toString('base64')}`};
  }
  async logout(){ if(this.context){ await this.context.close().catch(()=>{}); this.context=null; this.page=null; } }
  async sendDM(username,message){
    await this.ensure();
    await this.page.goto(`https://www.instagram.com/${encodeURIComponent(username)}/`,{waitUntil:'domcontentloaded',timeout:45000});
    await this.page.waitForTimeout(2500);
    const url=this.page.url();
    if(url.includes('/accounts/login')) throw new Error('Instagram não está logado.');
    if(url.includes('/challenge')||url.includes('/checkpoint')||url.includes('/suspended')) throw new Error('Instagram solicitou verificação da conta.');
    const names=/enviar mensagem|mensagem|message|send message/i;
    let clicked=false;
    for(const locator of [this.page.getByRole('button',{name:names}),this.page.getByRole('link',{name:names}),this.page.locator('div[role="button"]').filter({hasText:names})]){
      if(await this.count(locator.first())){ await locator.first().click({timeout:5000}).catch(()=>{}); clicked=true; break; }
    }
    if(!clicked) return {status:'skipped',reason:'Botão de mensagem não encontrado'};
    await this.page.waitForTimeout(2500);
    const contact=this.page.getByRole('button',{name:/enviar solicitação|send contact|contact request/i}).first(); if(await this.count(contact)) await contact.click().catch(()=>{});
    await this.page.waitForTimeout(1500);
    const box=this.page.locator('[contenteditable="true"]').last();
    if(!await this.count(box)) return {status:'skipped',reason:'Campo de mensagem não encontrado'};
    await box.click(); await box.fill(message).catch(async()=>{ await box.pressSequentially(message,{delay:5}); });
    await box.press('Enter'); await this.page.waitForTimeout(1200);
    return {status:'sent'};
  }
}
