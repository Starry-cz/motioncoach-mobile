const blankProfile={nickname:"",height:"",weight:"",sport:"",avatar:""};

async function thumbnail(file) {
  const url=URL.createObjectURL(file);
  try {
    const image=new Image();
    await new Promise((resolve,reject)=>{
      image.onload=resolve;
      image.onerror=reject;
      image.src=url;
    });
    // 头像只保存居中裁切的小图，原照片不写入应用存储。
    const size=Math.min(image.naturalWidth,image.naturalHeight);
    const canvas=document.createElement("canvas");
    canvas.width=canvas.height=192;
    const pixels=canvas.getContext("2d");
    pixels.fillStyle="#eaf1f8";
    pixels.fillRect(0,0,192,192);
    pixels.drawImage(image,(image.naturalWidth-size)/2,(image.naturalHeight-size)/2,size,size,0,0,192,192);
    return canvas.toDataURL("image/jpeg",.86);
  } finally {
    URL.revokeObjectURL(url);
  }
}

function showAvatar(image,{nickname,avatar}) {
  const initial=image.previousElementSibling;
  initial.textContent=Array.from(nickname)[0] || "我";
  initial.hidden=Boolean(avatar);
  image.hidden=!avatar;
  if(avatar)image.src=avatar;
  else image.removeAttribute("src");
}

export function mountProfile(dialog) {
  const $=selector=>dialog.querySelector(selector);
  const home=$("#profile-home"),form=$("#profile-form"),heading=$("#settings-title");
  const file=$("#profile-avatar-file"),remove=$("#remove-profile-avatar"),save=$("#save-profile");
  const edit=$("#edit-profile"),status=$("#profile-status");
  let storageKey=null,profile=blankProfile,draftAvatar="",photoRequest=0;

  function showHome() {
    // 返回个人中心时丢弃未保存的改动和仍在处理的头像。
    photoRequest++;
    form.hidden=true;
    home.hidden=false;
    heading.textContent="个人中心";
    dialog.scrollTop=0;
  }

  function render() {
    $("#profile-name").textContent=profile.nickname || "我的资料";
    $("#profile-sport-summary").textContent=profile.sport || "—";
    $("#profile-height-summary").textContent=profile.height?profile.height+" cm":"—";
    $("#profile-weight-summary").textContent=profile.weight?profile.weight+" kg":"—";
    showAvatar($("#profile-avatar"),profile);
  }

  function preview() {
    showAvatar($("#profile-avatar-preview"),{nickname:form.elements.nickname.value.trim(),avatar:draftAvatar});
    remove.hidden=!draftAvatar;
  }

  edit.onclick=()=>{
    for(const name of ["nickname","height","weight","sport"])form.elements[name].value=profile[name];
    draftAvatar=profile.avatar;
    file.value="";
    status.textContent="";
    save.disabled=false;
    preview();
    home.hidden=true;
    form.hidden=false;
    heading.textContent="编辑资料";
    heading.focus();
    dialog.scrollTop=0;
  };
  $("#cancel-profile").onclick=()=>{showHome();edit.focus();};
  form.elements.nickname.oninput=preview;
  $("#choose-profile-avatar").onclick=()=>file.click();
  remove.onclick=()=>{
    photoRequest++;
    draftAvatar="";
    file.value="";
    status.textContent="";
    save.disabled=false;
    preview();
  };
  file.onchange=async()=>{
    const selected=file.files[0];
    if(!selected)return;
    const request=++photoRequest;
    save.disabled=true;
    status.textContent="正在处理头像…";
    try {
      const photo=await thumbnail(selected);
      if(request!==photoRequest)return;
      draftAvatar=photo;
      status.textContent="";
      preview();
    } catch {
      if(request===photoRequest)status.textContent="无法打开这张图片，请换一张。";
    } finally {
      if(request===photoRequest){save.disabled=false;file.value="";}
    }
  };
  form.onsubmit=event=>{
    event.preventDefault();
    if(!storageKey || save.disabled)return;
    const next=Object.fromEntries(["nickname","height","weight","sport"].map(name=>[name,form.elements[name].value.trim()]));
    next.avatar=draftAvatar;
    try {
      localStorage.setItem(storageKey,JSON.stringify(next));
    } catch {
      status.textContent="本机暂时无法保存资料，请重试。";
      return;
    }
    profile=next;
    render();
    showHome();
    edit.focus();
  };
  dialog.addEventListener("close",showHome);

  return {showHome,setAccount(username){
    // 同一账号在不同手机上的资料互相独立，也不进入视频分析或 AI 请求。
    storageKey=username?"motioncoach-phone-profile."+username:null;
    profile=blankProfile;
    if(storageKey){
      try {profile={...blankProfile,...JSON.parse(localStorage.getItem(storageKey))};}
      catch { /* 首次使用或本机存储不可用时显示空白资料。 */ }
    }
    render();
    showHome();
  }};
}
