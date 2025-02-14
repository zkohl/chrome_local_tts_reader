let currentAudio = null;
let currentBlob = null;
let isPlaying = false;

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
  
  switch(state) {
    case 'playing':
      playBtn.disabled = true;
      pauseBtn.disabled = false;
      stopBtn.disabled = false;
      downloadBtn.disabled = !currentBlob;
      break;
    case 'paused':
      playBtn.disabled = false;
      pauseBtn.disabled = true;
      stopBtn.disabled = false;
      downloadBtn.disabled = !currentBlob;
      break;
    case 'stopped':
      playBtn.disabled = false;
      pauseBtn.disabled = true;
      stopBtn.disabled = true;
      downloadBtn.disabled = !currentBlob;
      break;
    default:
      playBtn.disabled = false;
      pauseBtn.disabled = true;
      stopBtn.disabled = true;
      downloadBtn.disabled = true;
  }
}

async function generateSpeech(text) {
  const serverUrl = document.getElementById('serverUrl').value;
  const voice = document.getElementById('voice').value;
  const speed = document.getElementById('speed').value;
  const shouldRecord = document.getElementById('recordAudio').checked;

  const response = await fetch(serverUrl, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Accept': 'audio/mpeg, audio/wav, audio/*'
    },
    body: JSON.stringify({
      model: 'tts-1',
      voice: voice,
      input: text,
      speed: parseFloat(speed)
    })
  });

  if (!response.ok) {
    throw new Error(`HTTP error! status: ${response.status}`);
  }

  const blob = await response.blob();
  if (shouldRecord) {
    currentBlob = blob;
    updateControlButtons('playing');
  }
  return blob;
}

document.addEventListener('DOMContentLoaded', function() {
  // Load saved settings
  chrome.storage.local.get(['serverUrl', 'voice', 'speed', 'recordAudio'], function(result) {
    document.getElementById('serverUrl').value = result.serverUrl || 'http://192.168.86.201:8000/v1/audio/speech';
    document.getElementById('voice').value = result.voice || 'af_bella';
    document.getElementById('speed').value = result.speed || 1.0;
    document.getElementById('recordAudio').checked = result.recordAudio || false;
    document.querySelector('.speed-value').textContent = `${result.speed || 1.0}x`;
  });

  // Speed slider
  document.getElementById('speed').addEventListener('input', function(e) {
    document.querySelector('.speed-value').textContent = `${e.target.value}x`;
  });

  // Play button
  document.getElementById('playBtn').addEventListener('click', async function() {
    try {
      if (currentAudio && isPlaying) {
        currentAudio.play();
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
        const audioBlob = await generateSpeech(text);
        
        const audioUrl = URL.createObjectURL(audioBlob);
        currentAudio = new Audio(audioUrl);
        
        currentAudio.onplay = () => {
          isPlaying = true;
          updateControlButtons('playing');
        };
        
        currentAudio.onpause = () => {
          isPlaying = false;
          updateControlButtons('paused');
        };
        
        currentAudio.onended = () => {
          isPlaying = false;
          updateControlButtons('stopped');
          if (document.getElementById('recordAudio').checked) {
            updateStatus('Audio ready for download', false);
          }
        };

        currentAudio.play();
      }
    } catch (error) {
      console.error('Error:', error);
      updateStatus(error.message, true);
    }
  });

  // Pause button
  document.getElementById('pauseBtn').addEventListener('click', function() {
    if (currentAudio) {
      currentAudio.pause();
    }
  });

  // Stop button
  document.getElementById('stopBtn').addEventListener('click', function() {
    if (currentAudio) {
      currentAudio.pause();
      currentAudio.currentTime = 0;
      updateControlButtons('stopped');
      if (document.getElementById('recordAudio').checked && currentBlob) {
        updateStatus('Audio ready for download', false);
      }
    }
  });

  // Download button
  document.getElementById('downloadBtn').addEventListener('click', function() {
    if (currentBlob) {
      const url = URL.createObjectURL(currentBlob);
      const a = document.createElement('a');
      a.href = url;
      a.download = 'speech.mp3';
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      URL.revokeObjectURL(url);
      updateStatus('Audio downloaded', false);
    }
  });

  // Save settings
  ['serverUrl', 'voice', 'speed', 'recordAudio'].forEach(id => {
    document.getElementById(id).addEventListener('change', function() {
      const settings = {
        serverUrl: document.getElementById('serverUrl').value,
        voice: document.getElementById('voice').value,
        speed: document.getElementById('speed').value,
        recordAudio: document.getElementById('recordAudio').checked
      };
      chrome.storage.local.set(settings, function() {
        updateStatus('Settings saved!', false);
      });
    });
  });

  // Initialize button states
  updateControlButtons('stopped');
});
