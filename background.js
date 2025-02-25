let offscreenDocument = null;
let isRecording = false;
let currentPlayerState = 'stopped';

// Create or get the offscreen document
async function setupOffscreenDocument() {
  // Check if we already have an offscreen document
  const existingContexts = await chrome.runtime.getContexts({
    contextTypes: ['OFFSCREEN_DOCUMENT']
  });

  if (existingContexts.length > 0) {
    offscreenDocument = existingContexts[0];
    return;
  }

  // Create an offscreen document
  await chrome.offscreen.createDocument({
    url: 'offscreen.html',
    reasons: ['AUDIO_PLAYBACK'],
    justification: 'Playing TTS audio in the background'
  });
}

// Handle messages from popup or offscreen document
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  switch (message.type) {
    case 'setupOffscreen':
      setupOffscreenDocument().then(() => sendResponse({ success: true }));
      return true;
      
    case 'startStreaming':
      isRecording = message.record;
      // Set state to loading before starting the audio stream
      currentPlayerState = 'loading';
      chrome.runtime.sendMessage({ 
        type: 'playerStateUpdate', 
        state: 'loading' 
      });
      startStreamingAudio(message.text, message.settings);
      sendResponse({ success: true });
      return true;
      
    case 'controlAudio':
      chrome.runtime.sendMessage({ 
        type: message.action, 
        data: message.data 
      });
      return true;
      
    case 'stateUpdate':
      currentPlayerState = message.state;
      chrome.runtime.sendMessage({ 
        type: 'playerStateUpdate', 
        state: message.state 
      });
      return true;
      
    case 'audioReady':
      // Audio is ready but not yet playing
      if (currentPlayerState === 'loading') {
        chrome.runtime.sendMessage({ 
          type: 'playerStateUpdate', 
          state: 'ready' 
        });
      }
      return true;
      
    case 'getPlayerState':
      sendResponse({ state: currentPlayerState });
      return true;
  }
});

// Start streaming audio from the TTS server
async function startStreamingAudio(text, settings) {
  try {
    await setupOffscreenDocument();
    
    const response = await fetch(settings.serverUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Accept': 'audio/mpeg, audio/wav, audio/*'
      },
      body: JSON.stringify({
        model: 'tts-1',
        voice: settings.voice,
        input: text,
        speed: parseFloat(settings.speed)
      })
    });

    if (!response.ok) {
      throw new Error(`HTTP error! status: ${response.status}`);
    }

    // Get the audio data as a blob
    const audioBlob = await response.blob();
    const mimeType = audioBlob.type || 'audio/mpeg';
    
    // Convert blob to array buffer to send to offscreen document
    const arrayBuffer = await audioBlob.arrayBuffer();
    
    // Send the audio data to the offscreen document
    chrome.runtime.sendMessage({ 
      type: 'processAudioData', 
      audioData: Array.from(new Uint8Array(arrayBuffer)),
      mimeType: mimeType,
      isRecording: isRecording
    });
  } catch (error) {
    console.error('Error streaming audio:', error);
    chrome.runtime.sendMessage({ 
      type: 'streamError', 
      error: error.message 
    });
    
    // Update state to stopped on error
    currentPlayerState = 'stopped';
    chrome.runtime.sendMessage({ 
      type: 'playerStateUpdate', 
      state: 'stopped' 
    });
  }
}