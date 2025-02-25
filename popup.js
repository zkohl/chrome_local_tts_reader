let audioPlayer = null;
let currentAudioUrl = null;

function updateStatus(message, isError = false) {
  const status = document.getElementById('status');
  status.textContent = message;
  status.className = `visible ${isError ? 'error' : 'success'}`;
  setTimeout(() => status.className = '', 3000);
}

function updateControlButtons(state) {
  const playBtn = document.getElementById('playBtn');
  const pauseBtn = document.getElementById('pauseBtn');
  const stopBtn = document.getElementById('stopBtn');
  const downloadBtn = document.getElementById('downloadBtn');
  const loadingIndicator = document.getElementById('loadingIndicator');
  
  // Hide loading indicator by default
  loadingIndicator.style.display = 'none';
  
  switch(state) {
    case 'loading':
      playBtn.disabled = true;
      pauseBtn.disabled = true;
      stopBtn.disabled = true;
      downloadBtn.disabled = true;
      loadingIndicator.style.display = 'block';
      break;
    case 'ready':
      playBtn.disabled = false;
      pauseBtn.disabled = true;
      stopBtn.disabled = false;
      downloadBtn.disabled = !currentAudioUrl;
      break;
    case 'playing':
      playBtn.disabled = true;
      pauseBtn.disabled = false;
      stopBtn.disabled = false;
      downloadBtn.disabled = !currentAudioUrl;
      break;
    case 'paused':
      playBtn.disabled = false;
      pauseBtn.disabled = true;
      stopBtn.disabled = false;
      downloadBtn.disabled = !currentAudioUrl;
      break;
    case 'stopped':
      playBtn.disabled = false;
      pauseBtn.disabled = true;
      stopBtn.disabled = true;
      downloadBtn.disabled = !currentAudioUrl;
      break;
    default:
      playBtn.disabled = false;
      pauseBtn.disabled = true;
      stopBtn.disabled = true;
      downloadBtn.disabled = true;
  }
}

function getSettings() {
  return {
    serverUrl: document.getElementById('serverUrl').value,
    voice: document.getElementById('voice').value,
    speed: document.getElementById('speed').value,
    recordAudio: document.getElementById('recordAudio').checked
  };
}

async function saveSettings() {
  const settings = getSettings();
  await chrome.storage.local.set(settings);
  updateStatus('Settings saved!', false);
}

// Sync player state when popup opens
async function syncPlayerState() {
  if (audioPlayer) {
    const state = await audioPlayer.getState();
    updateControlButtons(state);
  }
}

document.addEventListener('DOMContentLoaded', async function() {
  // Initialize audio player
  audioPlayer = new AudioPlayer();
  await audioPlayer.init();
  
  // Load saved settings
  chrome.storage.local.get(['serverUrl', 'voice', 'speed', 'recordAudio'], function(result) {
    document.getElementById('serverUrl').value = result.serverUrl || DEFAULT_SETTINGS.serverUrl;
    document.getElementById('voice').value = result.voice || DEFAULT_SETTINGS.voice;
    document.getElementById('speed').value = result.speed || DEFAULT_SETTINGS.speed;
    document.getElementById('recordAudio').checked = result.recordAudio || DEFAULT_SETTINGS.recordAudio;
    document.querySelector('.speed-value').textContent = `${result.speed || DEFAULT_SETTINGS.speed}x`;
  });
  
  // Sync player state
  syncPlayerState();
  
  // Speed slider
  document.getElementById('speed').addEventListener('input', function(e) {
    document.querySelector('.speed-value').textContent = `${e.target.value}x`;
  });
  
  // Play button
  document.getElementById('playBtn').addEventListener('click', async function() {
    try {
      const state = await audioPlayer.getState();
      
      if (state === 'paused' || state === 'ready') {
        audioPlayer.resume();
        updateControlButtons('playing');
      } else {
        const tabs = await chrome.tabs.query({active: true, currentWindow: true});
        const [tab] = tabs;
        const result = await chrome.scripting.executeScript({
          target: { tabId: tab.id },
          function: () => {
            const selection = window.getSelection();
            return selection.toString().trim() || document.body.innerText;
          },
        });

        const text = result[0].result;
        const settings = getSettings();
        
        await saveSettings();
        updateControlButtons('loading');
        await audioPlayer.play(text, settings);
      }
    } catch (error) {
      console.error('Error:', error);
      updateStatus(error.message, true);
      updateControlButtons('stopped');
    }
  });
  
  // Pause button
  document.getElementById('pauseBtn').addEventListener('click', function() {
    audioPlayer.pause();
    updateControlButtons('paused');
  });
  
  // Stop button
  document.getElementById('stopBtn').addEventListener('click', function() {
    audioPlayer.stop();
    updateControlButtons('stopped');
  });
  
  // Download button
  document.getElementById('downloadBtn').addEventListener('click', function() {
    if (currentAudioUrl) {
      const a = document.createElement('a');
      a.href = currentAudioUrl;
      a.download = 'speech.mp3';
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      updateStatus('Audio downloaded', false);
    }
  });
  
  // Save settings
  ['serverUrl', 'voice', 'speed', 'recordAudio'].forEach(id => {
    document.getElementById(id).addEventListener('change', saveSettings);
  });
  
  // Listen for messages from background script
  chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    switch (message.type) {
      case 'playerStateUpdate':
        updateControlButtons(message.state);
        break;
        
      case 'recordingComplete':
        currentAudioUrl = message.audioUrl;
        break;
        
      case 'streamError':
        updateStatus(message.error, true);
        updateControlButtons('stopped');
        break;
    }
  });
});