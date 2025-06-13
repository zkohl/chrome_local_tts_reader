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

// Set up context menu items
function setupContextMenu() {
  chrome.contextMenus.create({
    id: "readAloud",
    title: "Read Aloud",
    contexts: ["selection", "page"]
  });
}

// Handle context menu clicks
chrome.contextMenus.onClicked.addListener((info, tab) => {
  if (info.menuItemId === "readAloud") {
    let text = info.selectionText || "";
    
    if (!text) {
      // If no text is selected, get the page content
      chrome.scripting.executeScript({
        target: { tabId: tab.id },
        function: () => {
          return document.body.innerText;
        }
      }).then(results => {
        if (results && results[0] && results[0].result) {
          processAndReadText(results[0].result, tab.id);
        }
      });
    } else {
      // Use the selected text
      processAndReadText(text, tab.id);
    }
  }
});

// Process and read text with default settings
async function processAndReadText(text, tabId) {
  try {
    // Get default settings (same as popup.js)
    const savedSettings = await chrome.storage.local.get({
      serverUrl: 'http://localhost:8000/v1/audio/speech',
      voice: 'af_bella',
      speed: 1.0,
      recordAudio: false,
      preprocessText: true,
      voiceMode: 'preset',
      customVoice: ''
    });
    
    // Determine the actual voice to use based on voice mode
    const customVoiceValid = savedSettings.customVoice && 
      typeof savedSettings.customVoice === 'string' && 
      savedSettings.customVoice.trim().length > 0;

    const useCustomVoice = savedSettings.voiceMode === 'custom' && customVoiceValid;

    if (savedSettings.voiceMode === 'custom' && !customVoiceValid) {
      throw new Error('Custom voice mode selected but no valid custom voice provided');
    }

    const settings = {
      ...savedSettings,
      voice: useCustomVoice ? savedSettings.customVoice.trim() : savedSettings.voice
    };
    
    // Process text if enabled
    if (settings.preprocessText && tabId) {
      try {
        // Inject the text processor script if needed
        await chrome.scripting.executeScript({
          target: { tabId: tabId },
          files: ['textProcessor.js']
        });
        
        // Process the text
        const result = await chrome.scripting.executeScript({
          target: { tabId: tabId },
          func: (textToProcess) => {
            return window.TextProcessor.process(textToProcess);
          },
          args: [text]
        });
        
        if (result && result[0] && result[0].result) {
          text = result[0].result;
        }
      } catch (error) {
        console.error('Error processing text:', error);
        // Fall back to using the original text
      }
    }
    
    // Set state to loading
    currentPlayerState = 'loading';
    chrome.runtime.sendMessage({ 
      type: 'playerStateUpdate', 
      state: 'loading' 
    });
    
    // Start streaming audio
    startStreamingAudio(text, settings);
  } catch (error) {
    console.error('Error in processAndReadText:', error);
    chrome.runtime.sendMessage({ 
      type: 'streamError', 
      error: error.message 
    });
  }
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
        currentPlayerState = 'ready';
        chrome.runtime.sendMessage({ 
          type: 'playerStateUpdate', 
          state: 'ready' 
        });
      }
      return true;
      
    case 'getPlayerState':
      sendResponse({ state: currentPlayerState });
      return true;
      
    case 'seek':
      chrome.runtime.sendMessage({ 
        type: 'seek', 
        time: message.time 
      }, (response) => {
        sendResponse(response);
      });
      return true;
      
    case 'getTimeInfo':
      chrome.runtime.sendMessage({ 
        type: 'getTimeInfo' 
      }, (response) => {
        sendResponse(response);
      });
      return true;
      
    case 'timeUpdate':
      // Forward time updates to the popup
      chrome.runtime.sendMessage(message);
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

// Handle keyboard commands
chrome.commands.onCommand.addListener(async (command) => {
  if (command === 'read-aloud') {
    const tabs = await chrome.tabs.query({active: true, currentWindow: true});
    const [tab] = tabs;
    
    if (!tab) return;
    
    // Get selected text or page content, same logic as context menu
    chrome.scripting.executeScript({
      target: { tabId: tab.id },
      function: () => {
        const selection = window.getSelection();
        return selection.toString().trim() || document.body.innerText;
      }
    }).then(results => {
      if (results && results[0] && results[0].result) {
        processAndReadText(results[0].result, tab.id);
      }
    }).catch(error => {
      console.error('Error executing script for hotkey:', error);
    });
  }
});

// Initialize context menu when extension is installed or updated
chrome.runtime.onInstalled.addListener(() => {
  setupContextMenu();
});