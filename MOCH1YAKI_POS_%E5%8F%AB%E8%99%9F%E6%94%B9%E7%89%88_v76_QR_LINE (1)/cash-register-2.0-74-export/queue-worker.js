/**
 * MOCH1YAKI Queue v76 — LINE optional / QR self sign-up.
 * Cloudflare Workers + D1 (QUEUE_DB). Secrets:
 * LINE_CHANNEL_SECRET, LINE_CHANNEL_ACCESS_TOKEN, QUEUE_ADMIN_TOKEN.
 * Optional: TURNSTILE_SECRET_KEY (requires TURNSTILE_SITE_KEY public config var).
 * Existing LINE test reply and /webhook are preserved.
 * Run queue-schema.sql against the D1 database before deploying.
 */
const enc = new TextEncoder();
const twDay = () => new Intl.DateTimeFormat('en-CA', {timeZone:'Asia/Taipei',year:'numeric',month:'2-digit',day:'2-digit'}).format(new Date());
const now = () => new Date().toISOString();
const txt = (s, max=80) => String(s ?? '').trim().slice(0,max);
const jsonHeaders = {'Content-Type':'application/json; charset=utf-8','Cache-Control':'no-store','Access-Control-Allow-Origin':'*','Access-Control-Allow-Methods':'GET, POST, OPTIONS','Access-Control-Allow-Headers':'Authorization, Content-Type'};
const out = (body,status=200) => new Response(JSON.stringify(body),{status,headers:jsonHeaders});
const id = () => crypto.randomUUID();
const code = () => { const alphabet='ABCDEFGHJKLMNPQRSTUVWXYZ23456789';const a=crypto.getRandomValues(new Uint8Array(10));return [...a].map(x=>alphabet[x % alphabet.length]).join(''); };
const publicToken = () => [...crypto.getRandomValues(new Uint8Array(24))].map(x=>x.toString(16).padStart(2,'0')).join('');
const label = r => r ? String(r.seq).padStart(3,'0') : '---';
const validName = name => typeof name === 'string' && name.trim().length >= 1 && name.trim().length <= 24 && !/[<>\r\n]/.test(name);
const sameDay = d => d === twDay();
async function verifyLine(request,body,secret){
  if(!secret)return false;
  try{
    const signature=request.headers.get('x-line-signature')||'';
    const key=await crypto.subtle.importKey('raw',enc.encode(secret),{name:'HMAC',hash:'SHA-256'},false,['verify']);
    return crypto.subtle.verify('HMAC',key,Uint8Array.from(atob(signature),c=>c.charCodeAt(0)),enc.encode(body));
  }catch{return false;}
}
async function sendLine(env,endpoint,data){
  const r=await fetch('https://api.line.me/v2/bot/message/'+endpoint,{method:'POST',headers:{'Content-Type':'application/json','Authorization':'Bearer '+env.LINE_CHANNEL_ACCESS_TOKEN},body:JSON.stringify(data)});
  if(!r.ok){console.error('LINE API status',r.status);throw Error('LINE API '+r.status);}
}
async function lineWebhook(req,env){
  const raw=await req.text();
  if(!await verifyLine(req,raw,env.LINE_CHANNEL_SECRET))return out({error:'Invalid signature'},401);
  if(!env.LINE_CHANNEL_ACCESS_TOKEN||!env.QUEUE_DB)return out({error:'後端設定未完成'},503);
  let events;try{events=JSON.parse(raw).events||[];}catch{return out({error:'Invalid JSON'},400);}
  for(const ev of events){
    if(ev.type!=='message'||ev.message?.type!=='text'||!ev.replyToken)continue;
    const msg=ev.message.text.trim(); let answer='';
    if(msg==='測試')answer='𓊆 MOCH1YAKI 叫號系統 𓊇\n\nLINE 通知測試成功 ♡';
    const match=msg.match(/^綁定\s+([A-Z2-9]{10})$/i);
    if(match){
      const ticket=await env.QUEUE_DB.prepare('SELECT id,day,seq,status,wants_line,line_user_id FROM queue_tickets WHERE line_code=?').bind(match[1].toUpperCase()).first();
      if(!ticket||!sameDay(ticket.day)||['done','cancelled'].includes(ticket.status))answer='找不到有效的綁定碼，請重新查看排隊頁面。';
      else if(!ticket.wants_line)answer='這張號碼尚未開啟 LINE 通知，請在排隊頁面先選擇使用 LINE。';
      else if(ev.source?.type!=='user'||!ev.source.userId)answer='請在 LINE 官方帳號的一對一聊天室綁定。';
      else if(ticket.line_user_id&&ticket.line_user_id!==ev.source.userId)answer='這張號碼已綁定其他 LINE 帳號，請找工作人員協助。';
      else {
        await env.QUEUE_DB.prepare('UPDATE queue_tickets SET line_user_id=?,bound_at=? WHERE id=? AND (line_user_id IS NULL OR line_user_id=?)')
          .bind(ev.source.userId,now(),ticket.id,ev.source.userId).run();
        answer=`LINE 綁定成功！您的排隊號碼是 ${label(ticket)}。\n輪到您時會在這裡通知 ♡`;
      }
    }
    if(answer){try{await sendLine(env,'reply',{replyToken:ev.replyToken,messages:[{type:'text',text:answer}]});}catch(e){console.error('LINE reply failed:',String(e));}}
  }
  return out({ok:true});
}
async function getSettings(env,day){
  const r=await env.QUEUE_DB.prepare('SELECT paused,current_id FROM queue_days WHERE day=?').bind(day).first();
  return {paused:r ? Boolean(r.paused):true,currentId:r?.current_id||null};
}
async function summary(env,day){
  const settings=await getSettings(env,day);
  const stats=await env.QUEUE_DB.prepare("SELECT COUNT(*) AS total, COALESCE(SUM(CASE WHEN status='waiting' THEN 1 ELSE 0 END),0) AS waiting FROM queue_tickets WHERE day=?").bind(day).first();
  const cur=settings.currentId ? await env.QUEUE_DB.prepare('SELECT seq,status FROM queue_tickets WHERE id=? AND day=?').bind(settings.currentId,day).first():null;
  return {day,paused:settings.paused,current:cur&&['calling','called'].includes(cur.status)?label(cur):'---',waiting:stats?.waiting||0,total:stats?.total||0,event:'PF45｜AYAMI × YAKI',booth:'花博爭艷館 P15',officialUrl:txt(env.LINE_OFFICIAL_URL,300),turnstileSiteKey:txt(env.TURNSTILE_SITE_KEY,200)};
}
function ticketView(t){return {id:t.id,day:t.day,number:label(t),name:t.name,status:t.status,createdAt:t.created_at,calledAt:t.called_at,notification:t.notification||'',lineCode:t.line_code,wantsLine:Boolean(t.wants_line),lineBound:Boolean(t.line_user_id),sentAt:t.sent_at||null};}
async function incoming(req){try{return await req.json();}catch{return null;}}
async function checkCaptcha(req,env,body){
  if(!env.TURNSTILE_SECRET_KEY)return true;
  const token=txt(body.turnstileToken,3000);if(!token)return false;
  const form=new FormData();form.append('secret',env.TURNSTILE_SECRET_KEY);form.append('response',token);
  const remote=await fetch('https://challenges.cloudflare.com/turnstile/v0/siteverify',{method:'POST',body:form});
  return remote.ok&&Boolean((await remote.json()).success);
}
async function rateLimit(env,req){
  const ip=req.headers.get('CF-Connecting-IP')||'unknown';
  const digest=await crypto.subtle.digest('SHA-256',enc.encode(ip+':'+env.QUEUE_ADMIN_TOKEN+':'+Math.floor(Date.now()/60000)));
  const key=[...new Uint8Array(digest)].map(v=>v.toString(16).padStart(2,'0')).join('');
  const row=await env.QUEUE_DB.prepare('INSERT INTO queue_limits (bucket,count) VALUES (?,1) ON CONFLICT(bucket) DO UPDATE SET count=count+1 RETURNING count').bind(key).first();
  // Generous to avoid blocking multiple visitors sharing venue Wi-Fi.
  return Number(row?.count||1)<=50;
}
async function allocate(env,day,name,wantsLine){
  const seqRow=await env.QUEUE_DB.prepare('INSERT INTO queue_counters (day,last_seq) VALUES (?,1) ON CONFLICT(day) DO UPDATE SET last_seq=last_seq+1 RETURNING last_seq AS seq').bind(day).first();
  const seq=Number(seqRow.seq);
  const t={id:id(),day,seq,name:name.trim(),access_token:publicToken(),line_code:code(),wants_line:wantsLine?1:0,created_at:now()};
  await env.QUEUE_DB.prepare('INSERT INTO queue_tickets (id,day,seq,name,access_token,line_code,wants_line,status,created_at) VALUES (?,?,?,?,?,?,?,\'waiting\',?)')
    .bind(t.id,day,t.seq,t.name,t.access_token,t.line_code,t.wants_line,t.created_at).run();
  return {ticket:ticketView({...t,status:'waiting'}),token:t.access_token};
}
async function publicApi(req,url,env){
  if(req.method==='GET'&&url.pathname==='/public/config')return out(await summary(env,twDay()));
  if(req.method==='GET'&&url.pathname==='/public/status'){
    const day=twDay(); const base=await summary(env,day);
    const token=url.searchParams.get('token')||'';
    if(!/^[0-9a-f]{48}$/.test(token))return out({...base,ticket:null});
    const row=await env.QUEUE_DB.prepare('SELECT * FROM queue_tickets WHERE access_token=? AND day=?').bind(token,day).first();
    if(!row)return out({...base,ticket:null});
    const ahead=await env.QUEUE_DB.prepare("SELECT COUNT(*) AS n FROM queue_tickets WHERE day=? AND seq<? AND status IN ('waiting','calling')").bind(day,row.seq).first();
    return out({...base,ticket:ticketView(row),ahead:Number(ahead?.n||0)});
  }
  if(req.method!=='POST')return out({error:'Method not allowed'},405);
  const body=await incoming(req);if(!body)return out({error:'請傳送正確資料'},400);
  const day=twDay();
  if(url.pathname==='/public/join'){
    if((await getSettings(env,day)).paused)return out({error:'目前暫停開放領號，請稍後再試。'},403);
    if(!validName(body.name))return out({error:'請輸入 1–24 字的稱呼，不能包含換行或特殊括號。'},400);
    if(!await checkCaptcha(req,env,body))return out({error:'請完成防機器人驗證。'},403);
    if(!await rateLimit(env,req))return out({error:'此網路請求過於頻繁，請洽現場人員。'},429);
    return out(await allocate(env,day,body.name,Boolean(body.wantsLine)),201);
  }
  const token=String(body.token||'');
  if(!/^[0-9a-f]{48}$/.test(token))return out({error:'找不到有效號碼，請重新查看排隊頁面。'},401);
  const t=await env.QUEUE_DB.prepare('SELECT * FROM queue_tickets WHERE access_token=? AND day=?').bind(token,day).first();
  if(!t)return out({error:'找不到今天的排隊紀錄'},404);
  if(url.pathname==='/public/cancel'){
    if(['done','cancelled'].includes(t.status))return out({ok:true});
    await env.QUEUE_DB.prepare("UPDATE queue_tickets SET status='cancelled',line_user_id=NULL WHERE id=?").bind(t.id).run();
    return out({ok:true});
  }
  if(url.pathname==='/public/line'){
    if(['done','cancelled'].includes(t.status))return out({error:'此號碼已結束'},409);
    const value=body.wantsLine?1:0;
    await env.QUEUE_DB.prepare('UPDATE queue_tickets SET wants_line=?,line_user_id=CASE WHEN ?=0 THEN NULL ELSE line_user_id END WHERE id=?').bind(value,value,t.id).run();
    return out({ok:true});
  }
  return out({error:'Not Found'},404);
}
function adminAuth(req,env){
  const token=env.QUEUE_ADMIN_TOKEN;
  return Boolean(token&&token.length>=24&&req.headers.get('Authorization')==='Bearer '+token);
}
async function adminApi(req,url,env){
  if(!adminAuth(req,env))return out({error:'管理員密碼不正確或未設定'},401);
  const day=twDay();
  if(req.method==='GET'&&url.pathname==='/admin/queue'){
    const q=await env.QUEUE_DB.prepare('SELECT * FROM queue_tickets WHERE day=? ORDER BY seq ASC').bind(day).all();
    return out({...await summary(env,day),records:(q.results||[]).map(ticketView)});
  }
  if(req.method!=='POST')return out({error:'Method not allowed'},405);
  const body=await incoming(req);if(!body)return out({error:'Invalid JSON'},400);
  if(url.pathname==='/admin/open'){
    const paused=body.paused?1:0;
    await env.QUEUE_DB.prepare('INSERT INTO queue_days (day,paused,current_id) VALUES (?,?,NULL) ON CONFLICT(day) DO UPDATE SET paused=excluded.paused').bind(day,paused).run();
    return out({ok:true,paused:Boolean(paused)});
  }
  if(url.pathname==='/admin/create'){
    if(!validName(body.name))return out({error:'請輸入 1–24 字的顧客稱呼。'},400);
    return out(await allocate(env,day,body.name,Boolean(body.wantsLine)),201);
  }
  const ticketId=String(body.id||'');
  if(!/^[0-9a-f-]{36}$/i.test(ticketId))return out({error:'不正確的排隊號碼'},400);
  const t=await env.QUEUE_DB.prepare('SELECT * FROM queue_tickets WHERE id=? AND day=?').bind(ticketId,day).first();
  if(!t)return out({error:'找不到此號碼'},404);
  if(url.pathname==='/admin/edit'){
    if(!validName(body.name))return out({error:'請輸入 1–24 字的稱呼'},400);
    await env.QUEUE_DB.prepare('UPDATE queue_tickets SET name=? WHERE id=?').bind(body.name.trim(),t.id).run();
    return out({ok:true});
  }
  if(url.pathname==='/admin/call'){
    if(['done','cancelled'].includes(t.status))return out({error:'這張號碼已結束'},409);
    await env.QUEUE_DB.batch([
      env.QUEUE_DB.prepare("UPDATE queue_tickets SET status='called' WHERE day=? AND status='calling' AND id<>?").bind(day,t.id),
      env.QUEUE_DB.prepare("UPDATE queue_tickets SET status='calling',called_at=? WHERE id=?").bind(now(),t.id),
      env.QUEUE_DB.prepare('INSERT INTO queue_days (day,paused,current_id) VALUES (?,1,?) ON CONFLICT(day) DO UPDATE SET current_id=excluded.current_id').bind(day,t.id)
    ]);
    return notifyTicket(env,t.id);
  }
  if(url.pathname==='/admin/notify')return notifyTicket(env,t.id);
  if(url.pathname==='/admin/done'||url.pathname==='/admin/cancel'){
    const next=url.pathname==='/admin/done'?'done':'cancelled';
    await env.QUEUE_DB.batch([
      env.QUEUE_DB.prepare('UPDATE queue_tickets SET status=?,line_user_id=CASE WHEN ?=\'cancelled\' THEN NULL ELSE line_user_id END WHERE id=?').bind(next,next,t.id),
      env.QUEUE_DB.prepare('UPDATE queue_days SET current_id=NULL WHERE day=? AND current_id=?').bind(day,t.id)
    ]);
    return out({ok:true});
  }
  return out({error:'Not Found'},404);
}
async function notifyTicket(env,ticketId){
  const row=await env.QUEUE_DB.prepare('SELECT * FROM queue_tickets WHERE id=?').bind(ticketId).first();
  if(!row.wants_line||!row.line_user_id){
    await env.QUEUE_DB.prepare('UPDATE queue_tickets SET notification=? WHERE id=?').bind('未綁定 LINE，僅現場叫號',ticketId).run();
    return out({ok:true,notified:false,message:'未綁定 LINE，僅現場叫號'});
  }
  if(['cancelled','done'].includes(row.status))return out({error:'此號碼已結束'},409);
  const message=`【PF45 AYAMI × YAKI】\n您的號碼 ${label(row)} 已叫號！\n請至花博爭艷館 P15 攤位報到 ♡`;
  try{
    await sendLine(env,'push',{to:row.line_user_id,messages:[{type:'text',text:message}]});
    await env.QUEUE_DB.prepare('UPDATE queue_tickets SET sent_at=?,notification=? WHERE id=?').bind(now(),'LINE 已送出（不代表已讀）',ticketId).run();
    return out({ok:true,notified:true,message:'LINE 已送出（不代表已讀）'});
  }catch(e){
    await env.QUEUE_DB.prepare('UPDATE queue_tickets SET notification=? WHERE id=?').bind('LINE 發送失敗，請現場叫號',ticketId).run();
    return out({ok:true,notified:false,message:'LINE 發送失敗，請現場叫號'});
  }
}
export default {
  async fetch(req,env){
    const url=new URL(req.url);
    if(req.method==='OPTIONS')return new Response(null,{status:204,headers:jsonHeaders});
    if(url.pathname==='/'&&req.method==='GET')return new Response('MOCH1YAKI LINE notification service is running.',{headers:{'Content-Type':'text/plain; charset=utf-8'}});
    if(url.pathname==='/webhook'&&req.method==='POST')return lineWebhook(req,env);
    if(!env.QUEUE_DB)return out({error:'Cloudflare 尚未綁定 QUEUE_DB D1 資料庫'},503);
    try{
      if(url.pathname.startsWith('/public/'))return await publicApi(req,url,env);
      if(url.pathname.startsWith('/admin/'))return await adminApi(req,url,env);
      return out({error:'Not Found'},404);
    }catch(e){console.error('Queue Worker error:',String(e));return out({error:'伺服器處理失敗，請稍後再試。'},500);}
  }
};
