// Real shared-renderer acceptance with synthetic state. No provider, extension or production data.
if (!process.versions.electron) {
  const env = { ...process.env }; delete env.ELECTRON_RUN_AS_NODE;
  const result = require('node:child_process').spawnSync(require('electron'), [__filename], { env, encoding: 'utf8', windowsHide: true, timeout: 90000 });
  process.stdout.write(result.stdout || ''); process.stderr.write(result.stderr || ''); process.exit(result.status ?? 1);
}
const { app, BrowserWindow } = require('electron');
const { withoutScripts } = require('./ui-check-page.cjs');
const { fixtureConfigSource, BENIGN_RENDERER_ERRORS } = require('./fixtures/app-defaults.cjs');
const fs = require('node:fs'); const path = require('node:path'); const assert = require('node:assert/strict');
const root = path.resolve(__dirname, '..'), output = path.join(root, 'outputs/ai-studio-ui');
app.setPath('userData', path.join(output, 'runtime'));
app.on('window-all-closed', () => {});
app.whenReady().then(async () => {
  const { createServer } = await import('vite');
  const fixture = `
    localStorage.setItem('cos.ui.language','en');
    ${fixtureConfigSource()}
    const config=fixtureConfig({roots:[{name:'demo',path:'D:/Projects/Example'}],ui:{theme:'dark',autoConnect:false,lastSeenVersion:'2.1.50'},multiAgent:{enabled:false}});
    const state={config,hasApiKey:false,hasGoalKey:false,resolvedBinary:null,bundledTunnelVersion:null,
      status:{state:'disconnected',detail:'',publicUrl:null,localUrl:null,handshakeAt:null,lastRequestAt:null,lastToolCallAt:null,health:null,surfaces:[]},
      bridge:{running:true,port:0,paired:true,present:true,lastSeenAt:Date.now(),extensionVersion:null},
      update:{current:'2.1.50',latest:null,stage:'idle',error:null,checkedAt:null}};
    const ok=data=>Promise.resolve({ok:true,data}), stored=text=>({text,chars:text.length,truncated:false});
    window.fixtureRows=[];window.fixtureEvents=[];window.sent=[];window.changed=()=>{};
    const chat={id:'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee',sessionId:'fixture-session',conversationId:'studio-aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee',title:'Build a greeting function',url:'https://aistudio.google.com/prompts/new_chat',rootName:'demo',coding:true,busy:false,connected:true,error:null};
    window.fixtureChat=chat;
    window.api=new Proxy({getState:()=>ok(state),getLog:()=>ok([]),listProjects:()=>ok([]),
      listSessions:()=>ok({sessions:window.fixtureRows,total:window.fixtureRows.length,nextCursor:null,activeId:null,pressure:[],blocked:[],approval:[],trusted:[],recoveryStopped:[]}),
      getSession:(id,options)=>ok({summary:window.fixtureRows[0],total:window.fixtureEvents.length,nextFrom:window.fixtureEvents.length+1,events:window.fixtureEvents.filter(e=>!options?.from||e.seq>=options.from)}),
      listInputs:()=>ok([]),runningTools:()=>ok([]),runningProcesses:()=>ok([]),turnTraces:()=>ok({}),
      getSwarm:()=>ok({running:false,runId:null,agents:[],maxWorkers:2,pendingReports:0}),getChatModels:()=>ok({state:'unknown',models:[]}),
      onSessionChanged:listener=>{window.changed=listener;return()=>{}},studioControls:()=>ok({chat,plan:null}),
      studioSend:input=>{window.sent.push(input);chat.busy=true;const now=Date.now();window.fixtureRows=[{id:chat.sessionId,title:chat.title,conversationId:chat.conversationId,chatIds:[chat.conversationId],startedAt:now,updatedAt:now,endedAt:null,events:2,userMessages:1,toolCalls:0,lastToolCallAt:null,processExitNonzero:0,toolRejected:0,toolInternalErrors:0,errors:0,estimatedTokens:0,contextTokens:0,lastHandoffId:null,lastHandoffAt:null,lastTurnOutcome:null,activeTurnId:'fixture-turn',agents:[],origin:null}];window.fixtureEvents=[{kind:'user_message',seq:1,time:now,source:'app',messageId:'fixture-question',message:stored(input.text)},{kind:'turn_start',seq:2,time:now,source:'app',turnId:'fixture-turn'}];return ok(chat)},
      studioStop:()=>{chat.busy=false;return ok()},saveSettings:()=>ok(state)
    },{get:(target,key)=>key in target?target[key]:()=>ok(null)});
    window.finishFixture=()=>{const now=Date.now();chat.busy=false;Object.assign(window.fixtureRows[0],{activeTurnId:null,lastTurnOutcome:'completed',events:5,updatedAt:now,toolCalls:1});window.fixtureEvents.push(
      {kind:'tool_call',seq:3,time:now,source:'mcp',turnId:'fixture-turn',call:{callId:'fixture-call',tool:'apply_patch',attribution:'request_id',attributionMethod:'request_id',requestId:'fixture-request',conversationId:chat.conversationId,args:stored('{}'),result:stored('Created src/greeting.ts. Tests passed.'),outcome:'ok',durationMs:12,summary:{title:'Edited src/greeting.ts',tone:'good',kind:'edit'},changes:[{path:'/demo/src/greeting.ts',added:3,removed:0}]}},
      {kind:'assistant_message',seq:4,time:now+1,source:'extension',turnId:'fixture-turn',messageId:'fixture-answer',message:stored('Created src/greeting.ts with a typed greeting function. Verified: all 4 tests passed.'),final:true,state:'final'},
      {kind:'turn_end',seq:5,time:now+2,source:'app',turnId:'fixture-turn',outcome:'completed'});window.changed({sessionIds:[chat.sessionId]})};
    await import('/main.ts');window.fixtureReady=true;
  `;
  const iconFiles=['@phosphor-icons/web/regular/Phosphor.woff2','@phosphor-icons/web/fill/Phosphor-Fill.woff2'].map(file=>fs.realpathSync(require.resolve(file)));
  const server=await createServer({configFile:false,root:path.join(root,'src/renderer'),server:{host:'127.0.0.1',port:0,fs:{allow:[root,...iconFiles]}},plugins:[{name:'studio-fixture',configureServer(vite){vite.middlewares.use('/fixture.html',async(_req,res)=>{const source=withoutScripts(fs.readFileSync(path.join(root,'src/renderer/index.html'),'utf8')).replace('</body>','<script type="module">'+fixture+'</script></body>');res.setHeader('Content-Type','text/html');res.end(await vite.transformIndexHtml('/fixture.html',source));});}}]});
  let win;
  try {
    await server.listen();fs.mkdirSync(output,{recursive:true});win=new BrowserWindow({show:false,width:1200,height:850,webPreferences:{sandbox:true,backgroundThrottling:false}});
    const errors=[];win.webContents.on('console-message',event=>{if(event.level==='error'&&!BENIGN_RENDERER_ERRORS.includes(event.message))errors.push(event.message)});
    await win.loadURL(server.resolvedUrls.local[0]+'fixture.html');const js=code=>win.webContents.executeJavaScript(code);
    async function until(code){for(let i=0;i<240;i++){if(await js(code))return;await new Promise(resolve=>setTimeout(resolve,25))}throw new Error('UI condition timed out: '+code+'; console: '+JSON.stringify(errors))}
    await until('window.fixtureReady && document.getElementById("chatProviderRoot").options.length===2');
    await js(`document.getElementById('sidebarStudio').click();document.getElementById('chatInput').value='Create a typed greeting function and run its tests.';document.getElementById('chatInput').dispatchEvent(new Event('input',{bubbles:true}));document.getElementById('composer').requestSubmit()`);
    await until('window.sent.length===1 && document.getElementById("chatInput").value==="" && document.getElementById("chatProvider").disabled');
    assert.deepEqual(await js('window.sent[0]'),{text:'Create a typed greeting function and run its tests.',coding:true,rootName:'demo'});
    await until('document.getElementById("chatSend").dataset.action==="stop"');
    await js(`document.getElementById('chatInput').value='Keep this unsent draft';document.getElementById('chatInput').dispatchEvent(new Event('input',{bubbles:true}));window.finishFixture()`);
    await until('document.getElementById("timeline").textContent.includes("Verified: all 4 tests passed.")');
    assert.equal(await js('document.getElementById("chatInput").value'),'Keep this unsent draft');
    assert.equal(await js('document.getElementById("timeline").textContent.includes("cos_tool")'),false);
    assert.equal(await js('document.querySelector("[data-panel=chat]").classList.contains("is-active")'),true);
    assert.equal(await js('document.getElementById("chatProvider").value'),'studio');
    await js(`document.getElementById('chatInput').value='';document.getElementById('chatInput').dispatchEvent(new Event('input',{bubbles:true}));document.fonts.ready`);
    for(const[name,width,height,theme]of[['desktop-dark',1200,850,'dark'],['compact-light',900,760,'light']]){
      win.setSize(width,height);await js(`document.documentElement.dataset.theme='${theme}'`);await new Promise(resolve=>setTimeout(resolve,150));
      const layout=await js(`(()=>{const p=document.getElementById('composer');const b=document.getElementById('chatSend').getBoundingClientRect();return{overflow:p.scrollWidth>p.clientWidth+1,bottom:b.bottom,viewport:innerHeight}})()`);
      assert.equal(layout.overflow,false,name+' has no composer overflow');assert.ok(layout.bottom<=layout.viewport,name+' keeps Send on screen');
      await win.webContents.capturePage(undefined,{stayHidden:true,stayAwake:true});await new Promise(resolve=>setTimeout(resolve,200));fs.writeFileSync(path.join(output,name+'.png'),(await win.webContents.capturePage(undefined,{stayHidden:true,stayAwake:true})).toPNG());
    }
    assert.deepEqual(errors,[]);console.log('PASS: Gemini uses the shared CoS composer, sidebar, tool cards and timeline; drafts survive progress updates.');
  }finally{win?.destroy();await server.close()}
  app.quit();
}).catch(error=>{console.error(error);app.exit(1)});
