'use strict';

// Passkey（WebAuthn）的瀏覽器端：登入頁的「改用 Passkey 登入」與設定頁的「新增 Passkey」。
// 伺服器給的 JSON 選項與瀏覽器的 ArrayBuffer 在這裡互轉；不用 PublicKeyCredential.parseCreationOptionsFromJSON，舊一點的 Safari 沒有
(() => {
  if (window.gatewayPasskey) return; // 頁面可能載入兩次
  window.gatewayPasskey = true;

  function toBuffer(value) {
    const base64 = value.replace(/-/g, '+').replace(/_/g, '/');
    const binary = atob(base64.padEnd(Math.ceil(base64.length / 4) * 4, '='));
    return Uint8Array.from(binary, (ch) => ch.charCodeAt(0)).buffer;
  }

  function toBase64Url(buffer) {
    return btoa(String.fromCharCode(...new Uint8Array(buffer))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  }

  const descriptors = (list) => (list || []).map((item) => ({ ...item, id: toBuffer(item.id) }));

  function supported() {
    return typeof window.PublicKeyCredential === 'function' && Boolean(navigator.credentials);
  }

  function common(credential) {
    return {
      id: credential.id,
      rawId: toBase64Url(credential.rawId),
      type: credential.type,
      authenticatorAttachment: credential.authenticatorAttachment || undefined,
      clientExtensionResults: credential.getClientExtensionResults(),
    };
  }

  async function create(options) {
    const credential = await navigator.credentials.create({
      publicKey: {
        ...options,
        challenge: toBuffer(options.challenge),
        user: { ...options.user, id: toBuffer(options.user.id) },
        excludeCredentials: descriptors(options.excludeCredentials),
      },
    });
    const { response } = credential;
    return {
      ...common(credential),
      response: {
        clientDataJSON: toBase64Url(response.clientDataJSON),
        attestationObject: toBase64Url(response.attestationObject),
        transports: response.getTransports ? response.getTransports() : [],
      },
    };
  }

  async function get(options) {
    const credential = await navigator.credentials.get({
      publicKey: { ...options, challenge: toBuffer(options.challenge), allowCredentials: descriptors(options.allowCredentials) },
    });
    const { response } = credential;
    return {
      ...common(credential),
      response: {
        clientDataJSON: toBase64Url(response.clientDataJSON),
        authenticatorData: toBase64Url(response.authenticatorData),
        signature: toBase64Url(response.signature),
        userHandle: response.userHandle ? toBase64Url(response.userHandle) : undefined,
      },
    };
  }

  /** 瀏覽器丟出的錯誤轉成看得懂的說明；伺服器的錯誤訊息照原樣 */
  function message(err) {
    if (err.name === 'NotAllowedError') return '已取消，或這台裝置沒有可用的 Passkey';
    if (err.name === 'InvalidStateError') return '這個驗證器已經新增過了';
    if (err.name === 'SecurityError') return '目前的網址不能使用 Passkey（需要 HTTPS 或 localhost）';
    return err.message;
  }

  async function post(path, body, headers = {}) {
    const res = await fetch(path, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...headers },
      body: JSON.stringify(body),
      credentials: 'same-origin',
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || `請求失敗（${res.status}）`);
    return data;
  }

  function show(status, text, error) {
    status.textContent = text;
    status.classList.toggle('is-error', Boolean(error));
    status.setAttribute('role', error ? 'alert' : 'status');
  }

  // 登入頁
  const panel = document.getElementById('passkey-panel');
  if (panel && supported()) {
    panel.hidden = false;
    const button = document.getElementById('passkey-login');
    const status = document.getElementById('passkey-status');
    button.addEventListener('click', async () => {
      button.disabled = true;
      show(status, '等待 Passkey 驗證…');
      try {
        const options = await post('/login/passkey/options', {});
        const { redirect } = await post('/login/passkey', { next: panel.dataset.next, response: await get(options) });
        // 授權流程的 next 帶著 client 的參數，登入後回到同一頁
        window.location.assign(redirect);
      } catch (err) {
        show(status, message(err), true);
        button.disabled = false;
      }
    });
  }

  // 設定頁
  const addForm = document.getElementById('passkey-add-form');
  if (addForm && supported()) {
    addForm.hidden = false;
    const status = document.getElementById('passkey-add-status');
    const button = addForm.querySelector('button[type="submit"]');
    addForm.addEventListener('submit', async (event) => {
      event.preventDefault();
      const headers = { 'X-CSRF-Token': addForm.elements.csrf.value };
      button.disabled = true;
      show(status, '等待 Passkey 驗證…');
      try {
        const options = await post('/settings/passkeys/options', { password: addForm.elements.password.value }, headers);
        addForm.elements.password.value = '';
        await post('/settings/passkeys', { name: addForm.elements.name.value, response: await create(options) }, headers);
        window.location.reload();
      } catch (err) {
        show(status, message(err), true);
        button.disabled = false;
      }
    });
  }
})();
