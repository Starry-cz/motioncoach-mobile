const accountStore="unlock";
const activeAccount="current";
const marker="motioncoach-phone-login-v1";

function decode(text) {
  const value=text.replace(/-/g,"+").replace(/_/g,"/");
  return Uint8Array.from(atob(value),char=>char.charCodeAt(0));
}

export function accountPasswordBytes(password) {
  // 发布工具和手机端按同一规则把可打印的短口令补齐为 AES-128 密钥。
  if(!/^[!-~]{1,16}$/.test(password))return null;
  const bytes=new Uint8Array(16);
  bytes.set(new TextEncoder().encode(password));
  return bytes;
}

async function openSealed(key,additionalData,verifier) {
  const payload=decode(verifier);
  const plain=await crypto.subtle.decrypt({
    name:"AES-GCM",iv:payload.slice(0,12),additionalData:new TextEncoder().encode(additionalData)
  },key,payload.slice(12));
  return new TextDecoder().decode(plain);
}

async function accessRemembered(mode,operate) {
  // 浏览器只保存不可导出的本机解密对象。离线入口的持有者仍可在自己的设备上调用它。
  const database=await new Promise((resolve,reject)=>{
    const request=indexedDB.open("motioncoach-phone-account",1);
    request.onupgradeneeded=()=>request.result.createObjectStore(accountStore);
    request.onsuccess=()=>resolve(request.result);
    request.onerror=()=>reject(request.error);
  });
  try {
    return await new Promise((resolve,reject)=>{
      const transaction=database.transaction(accountStore,mode);
      const request=operate(transaction.objectStore(accountStore));
      transaction.oncomplete=()=>resolve(request.result);
      transaction.onabort=()=>reject(transaction.error);
    });
  } finally {database.close();}
}

export function mountAccount({onLogin}={}) {
  const username=document.documentElement.dataset.accountUser;
  const verifier=document.documentElement.dataset.accountVerifier;
  const coach=document.documentElement.dataset.defaultCoach;
  const gate=document.querySelector("#account-gate"),workspace=document.querySelector("#workspace");
  const form=document.querySelector("#login-form"),status=document.querySelector("#login-status");
  const accountName=document.querySelector("#account-name");
  const userField=form.elements.namedItem("username"),passwordField=form.elements.namedItem("password");
  const rememberField=form.elements.namedItem("remember");
  const submit=form.querySelector('[type="submit"]');
  let unlocked=false,attempt=0;

  async function remember(key) {
    // 当前用户退出或关闭记住登录时删除解密对象，持久化的个人 AI 配置原样保留。
    try {
      await accessRemembered("readwrite",store=>key?store.put({verifier,key},activeAccount):store.delete(activeAccount));
    } catch { /* 私密浏览仍可在本次打开期间使用。 */ }
  }

  function show(value) {
    unlocked=value;
    gate.hidden=value;
    workspace.hidden=!value;
    accountName.textContent=value?username:"";
    window.dispatchEvent(new CustomEvent("motioncoach-account",{detail:{unlocked:value,username:value?username:null}}));
  }

  async function logout() {
    attempt++;
    await remember(null);
    form.reset();
    submit.disabled=false;
    status.textContent="";
    show(false);
    userField.focus();
  }

  form.addEventListener("submit",async event=>{
    event.preventDefault();
    const current=++attempt;
    const user=userField.value.trim();
    const password=passwordField.value.trim();
    submit.disabled=true;
    status.textContent="";
    if(!username || !verifier || !crypto.subtle) {
      status.textContent="此设备暂时无法验证内测登录。请从新版 App 或 Safari 打开。";
      submit.disabled=false;
      return;
    }
    let key=null;
    const passwordBytes=user===username?accountPasswordBytes(password):null;
    if(passwordBytes) {
      try {
        const candidate=await crypto.subtle.importKey("raw",passwordBytes,"AES-GCM",false,["decrypt"]);
        if(await openSealed(candidate,username,verifier)===marker)key=candidate;
      } catch { /* 口令不匹配时认证解密会失败。 */ }
    }
    if(current!==attempt)return;
    if(!key) {
      submit.disabled=false;
      status.textContent="账号或密码有误，请重试。";
      passwordField.focus();
      return;
    }
    const coachKey=await defaultKey(key);
    await remember((rememberField?.checked ?? true)?key:null);
    if(current!==attempt)return;
    onLogin?.({coachKey});
    submit.disabled=false;
    form.reset();
    show(true);
  });

  document.querySelector("#logout").addEventListener("click",logout);
  async function defaultKey(key) {
    try {return coach?await openSealed(key,"motioncoach:coach:"+username,coach):null;}
    catch {return null;}
  }

  async function restore() {
    let saved;
    try {saved=await accessRemembered("readonly",store=>store.get(activeAccount));} catch {}
    if(attempt)return;
    if(saved?.verifier===verifier && saved?.key) {
      const coachKey=await defaultKey(saved.key);
      if(attempt)return;
      onLogin?.({coachKey});
      show(true);
    } else {
      show(false);
    }
  }

  restore();
  return {isUnlocked:()=>unlocked,logout};
}
