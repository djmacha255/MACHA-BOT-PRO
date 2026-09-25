const $ = selector => document.querySelector(selector);
const slot = $('#slot');
function notify(element, message) { element.textContent = message; setTimeout(() => { element.textContent = ''; }, 4500); }
const API_BASE = window.MACHA_API_URL || '';
async function api(path, options = {}) {
  const response = await fetch(`${API_BASE}${path}`, { headers: { 'Content-Type': 'application/json' }, ...options });
  const data = await response.json();
  if (!response.ok) throw new Error(data.error || 'Request failed');
  return data;
}
function render(data) {
  $('#botStatus').textContent = data.online ? 'ONLINE' : 'OFFLINE';
  $('#botNumber').textContent = data.number ? `+${data.number}` : 'Start bot socket to connect';
  $('#statusText').textContent = data.online ? 'Bot online' : 'Bot offline';
  $('#statusDot').style.background = data.online ? 'var(--lime)' : '#ef6b6b';
  const active = data.slots.filter(item => item.number).length;
  $('#activeSavers').textContent = `${active} / 10`;
  $('#chatStatus').textContent = data.chatbot.enabled ? 'ON' : 'OFF';
  $('#profileStatus').textContent = data.profile.enabled ? `${data.profile.intervalMinutes}m` : 'OFF';
  $('#profileImages').textContent = `${data.profile.images} images ready`;
  slot.innerHTML = data.slots.map(item => `<option value="${item.id}">${item.name}${item.number ? ` · +${item.number}` : ''}</option>`).join('');
  $('#chatEnabled').checked = data.chatbot.enabled;
  $('#personality').value = data.chatbot.personality;
  $('#prompt').value = data.chatbot.prompt;
  $('#profileEnabled').checked = data.profile.enabled;
  $('#interval').value = String(data.profile.intervalMinutes);
}
async function refresh() { try { render(await api('/api/status')); } catch (error) { $('#statusText').textContent = error.message; } }
$('#pairForm').addEventListener('submit', async event => {
  event.preventDefault();
  const result = $('#pairResult'); result.classList.remove('hidden'); result.innerHTML = '<span>Generating secure code...</span>';
  try { const data = await api('/api/pair', { method: 'POST', body: JSON.stringify({ slot: slot.value, number: $('#number').value }) }); result.innerHTML = `Pairing code: <code>${data.slot.pairingCode}</code><br><small>${data.instructions}</small>`; refresh(); }
  catch (error) { result.innerHTML = `<span>${error.message}</span>`; }
});
$('#saveChat').addEventListener('click', async () => { try { await api('/api/chatbot', { method: 'POST', body: JSON.stringify({ enabled: $('#chatEnabled').checked, personality: $('#personality').value, prompt: $('#prompt').value }) }); notify($('#chatNotice'), 'Chatbot settings saved.'); refresh(); } catch (error) { notify($('#chatNotice'), error.message); } });
$('#saveProfile').addEventListener('click', async () => { try { await api('/api/profile', { method: 'POST', body: JSON.stringify({ enabled: $('#profileEnabled').checked, intervalMinutes: $('#interval').value }) }); notify($('#profileNotice'), 'Dynamic profile settings saved.'); refresh(); } catch (error) { notify($('#profileNotice'), error.message); } });
refresh(); setInterval(refresh, 15000);
