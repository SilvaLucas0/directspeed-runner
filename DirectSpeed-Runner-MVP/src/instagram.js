import fs from 'node:fs';
import path from 'node:path';
import { chromium } from 'playwright';

export class InstagramSession {
  constructor(userId) { this.userId=userId; this.context=null; this.page=null; }
  async ensure() {
    if (this.context) return;
    const root=process.env.DATA_DIR||'./data'; const dir=path.join(root,'browser',this.userId); fs.mkdirSync(dir,{recursive:true});
    this.context=await chromium.launchPersistentContext(dir,{headless:String(process.env.HEADLESS||'true')!=='false',viewport:{width:1280,height:900},locale:'pt-BR'});
    this.page=this.context.pages()[0] || await this.context.newPage();
  }
  async inspectLogin() {
    await this.ensure(); const url=this.page.url();
    if (url.includes('/challenge') || url.includes('/checkpoint')) return {state:'checkpoint',url};
    const twoFactor = url.includes('/two_factor') || await this.page.locator('input[name="verificationCode"], input[autocomplete="one-time-code"]').count().catch(()=>0);
    if (twoFactor) return {state:'two_factor',url};
    if (url.includes('/accounts/login')) return {state:'login_required',url};
    const logged = await this.page.locator('a[href="/direct/inbox/"], svg[aria-label="Direct"], a[href*="/accounts/edit/"]').count().catch(()=>0);
    return logged ? {state:'connected',url} : {state:'login_required',url};
  }
  async login(username,password) {
    await this.ensure();
    await this.page.goto('https://www.instagram.com/accounts/login/',{waitUntil:'domcontentloaded',timeout:45000});
    await this.page.locator('input[name="username"]').fill(username);
    await this.page.locator('input[name="password"]').fill(password);
    await Promise.allSettled([this.page.waitForLoadState('domcontentloaded',{timeout:20000}),this.page.locator('button[type="submit"]').click()]);
    await this.page.waitForTimeout(5000);
    return this.inspectLogin();
  }
  async submitTwoFactor(code){
    await this.ensure(); const input=this.page.locator('input[name="verificationCode"], input[autocomplete="one-time-code"]').first();
    if(!await input.count()) throw new Error('Campo de verificação não encontrado.');
    await input.fill(code); const button=this.page.getByRole('button',{name:/confirmar|confirm|avançar|next|enviar|submit/i}).first();
    if(await button.count()) await button.click(); else await input.press('Enter');
    await this.page.waitForTimeout(5000); return this.inspectLogin();
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
      if(await locator.first().count().catch(()=>0)){ await locator.first().click({timeout:5000}).catch(()=>{}); clicked=true; break; }
    }
    if(!clicked) return {status:'skipped',reason:'Botão de mensagem não encontrado'};
    await this.page.waitForTimeout(2500);
    const contact=this.page.getByRole('button',{name:/enviar solicitação|send contact|contact request/i}).first(); if(await contact.count().catch(()=>0)) await contact.click().catch(()=>{});
    await this.page.waitForTimeout(1500);
    const box=this.page.locator('[contenteditable="true"]').last();
    if(!await box.count().catch(()=>0)) return {status:'skipped',reason:'Campo de mensagem não encontrado'};
    await box.click(); await box.fill(message).catch(async()=>{ await box.pressSequentially(message,{delay:5}); });
    await box.press('Enter'); await this.page.waitForTimeout(1200);
    return {status:'sent'};
  }
}
