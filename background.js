let offscreenDocument = null;
let isRecording = false;
let currentPlayerState = 'stopped';
let currentChunkSession = null;
let textChunker = null;
let activeAbortController = null;

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
  
  // Wait for the offscreen document to be ready
  await new Promise(resolve => setTimeout(resolve, 200));
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
chrome.contextMenus.onClicked.addListener(async (info, tab) => {
  if (info.menuItemId === "readAloud") {
    try {
      // Always use the shared text extractor for consistency
      await chrome.scripting.executeScript({
        target: { tabId: tab.id },
        files: ['textExtractor.js']
      });
      
      const pageDataResult = await chrome.scripting.executeScript({
        target: { tabId: tab.id },
        function: () => window.extractPageText()
      });
      
      if (pageDataResult && pageDataResult[0] && pageDataResult[0].result) {
        processAndReadText(pageDataResult[0].result, tab.id);
      }
    } catch (error) {
      console.error('Error executing script for context menu:', error);
    }
  }
});

// Log performance summary for completed chunk session
function logPerformanceSummary() {
  if (!currentChunkSession || !currentChunkSession.chunkTimings) {
    return;
  }
  
  const session = currentChunkSession;
  const totalSessionTime = Date.now() - session.startTime;
  const completedChunks = Object.keys(session.chunkTimings).length;
  
  console.log(`📊 PERFORMANCE SUMMARY - Session ${session.id}`);
  console.log(`📝 Total chunks: ${session.totalChunks}`);
  console.log(`✅ Completed chunks: ${completedChunks}`);
  console.log(`⏱️ Total session time: ${totalSessionTime}ms`);
  
  if (completedChunks > 0) {
    const processingTimes = Object.values(session.chunkTimings)
      .filter(timing => timing.completedTime)
      .map(timing => timing.completedTime - timing.startTime);
    
    const avgProcessingTime = processingTimes.reduce((a, b) => a + b, 0) / processingTimes.length;
    const minProcessingTime = Math.min(...processingTimes);
    const maxProcessingTime = Math.max(...processingTimes);
    
    const totalTextLength = Object.values(session.chunkTimings)
      .reduce((total, timing) => total + (timing.textLength || 0), 0);
    
    console.log(`📏 Total text length: ${totalTextLength} characters`);
    console.log(`⚡ Avg processing time per chunk: ${Math.round(avgProcessingTime)}ms`);
    console.log(`🏃 Fastest chunk: ${minProcessingTime}ms`);
    console.log(`🐌 Slowest chunk: ${maxProcessingTime}ms`);
    console.log(`📈 Characters per second: ${Math.round(totalTextLength / (totalSessionTime / 1000))}`);
    
    // Log individual chunk timings
    console.log(`📋 Individual chunk timings:`);
    Object.entries(session.chunkTimings).forEach(([index, timing]) => {
      if (timing.completedTime) {
        const processingTime = timing.completedTime - timing.startTime;
        console.log(`  Chunk ${index}: ${processingTime}ms (${timing.textLength} chars, ${Math.round(timing.textLength / (processingTime / 1000))} chars/sec)`);
      }
    });
  }
  
  console.log(`📊 END PERFORMANCE SUMMARY`);
}

// Initialize text chunker
function initializeTextChunker() {
  if (!textChunker) {
    // Create a proper text chunker with intelligent paragraph splitting
    textChunker = {
      maxChunkSize: 400, // Reduced for better performance
      minChunkSize: 100,
      
      chunkText: function(text) {
        if (!text || text.trim().length === 0) {
          return [];
        }
        
        console.log(`📝 Starting text chunking for ${text.length} characters`);
        
        // Split by double newlines (paragraphs)
        const paragraphs = text.split(/\n\s*\n/).filter(p => p.trim().length > 0);
        console.log(`📄 Found ${paragraphs.length} paragraphs`);
        
        const chunks = [];
        let currentChunk = '';
        
        for (let i = 0; i < paragraphs.length; i++) {
          const paragraph = paragraphs[i].trim();
          
          // If adding this paragraph would exceed max size, finalize current chunk
          if (currentChunk.length > 0 && 
              (currentChunk.length + paragraph.length + 2) > this.maxChunkSize) {
            chunks.push(currentChunk.trim());
            currentChunk = '';
          }
          
          // Add paragraph to current chunk
          if (currentChunk.length > 0) {
            currentChunk += '\n\n' + paragraph;
          } else {
            currentChunk = paragraph;
          }
          
          // If current chunk is getting large, split it
          if (currentChunk.length > this.maxChunkSize) {
            const sentences = currentChunk.split(/(?<=[.!?])\s+/);
            let tempChunk = '';
            
            for (const sentence of sentences) {
              if (tempChunk.length > 0 && 
                  (tempChunk.length + sentence.length + 1) > this.maxChunkSize) {
                chunks.push(tempChunk.trim());
                tempChunk = sentence;
              } else {
                tempChunk += (tempChunk.length > 0 ? ' ' : '') + sentence;
              }
            }
            
            currentChunk = tempChunk;
          }
        }
        
        // Add final chunk
        if (currentChunk.trim().length > 0) {
          chunks.push(currentChunk.trim());
        }
        
        // Merge very small chunks
        const mergedChunks = [];
        let accumulated = '';
        
        for (const chunk of chunks) {
          if (accumulated.length === 0) {
            accumulated = chunk;
          } else if (accumulated.length < this.minChunkSize || 
                     (accumulated.length + chunk.length + 2) <= this.maxChunkSize) {
            accumulated += '\n\n' + chunk;
          } else {
            mergedChunks.push(accumulated);
            accumulated = chunk;
          }
        }
        
        if (accumulated.length > 0) {
          mergedChunks.push(accumulated);
        }
        
        console.log(`✂️ Text split into ${mergedChunks.length} chunks:`, 
                   mergedChunks.map((chunk, i) => `${i}: ${chunk.length} chars`));
        
        return mergedChunks;
      }
    };
  }
}

// Process the next chunk in the current session
async function processNextChunk(expectedSessionId = null) {
  // Check if session is still valid and not cancelled
  if (!currentChunkSession) {
    console.log(`🛑 Session cancelled - stopping chunk processing`);
    return;
  }
  
  // Check if this call is for the current session (prevent stale setTimeout calls)
  if (expectedSessionId && currentChunkSession.id !== expectedSessionId) {
    console.log(`🛑 Session ID mismatch - stopping chunk processing (expected: ${expectedSessionId}, current: ${currentChunkSession?.id})`);
    return;
  }
  
  if (currentChunkSession.currentIndex >= currentChunkSession.chunks.length) {
    console.log(`✅ All chunks processed for session ${currentChunkSession.id}`);
    return;
  }
  
  const chunk = currentChunkSession.chunks[currentChunkSession.currentIndex];
  const chunkIndex = currentChunkSession.currentIndex;
  const sessionId = currentChunkSession.id;
  
  console.log(`🚀 Processing chunk ${chunkIndex + 1}/${currentChunkSession.totalChunks}: "${chunk.substring(0, 60)}..."`);
  
  // Record chunk start time
  const chunkStartTime = Date.now();
  currentChunkSession.chunkTimings[chunkIndex] = {
    startTime: chunkStartTime,
    textLength: chunk.length
  };
  
  try {
    // Start streaming this chunk
    await startStreamingAudioChunk(chunk, currentChunkSession.settings, chunkIndex, sessionId);
    
    // Check again if session is still valid after async operation
    if (!currentChunkSession || currentChunkSession.id !== sessionId) {
      console.log(`🛑 Session cancelled during chunk ${chunkIndex} processing`);
      return;
    }
    
    // Move to next chunk
    currentChunkSession.currentIndex++;
    
    // Continue processing if there are more chunks
    if (currentChunkSession.currentIndex < currentChunkSession.chunks.length) {
      // Small delay to prevent overwhelming the server
      setTimeout(() => processNextChunk(sessionId), 100);
    }
  } catch (error) {
    console.error(`❌ Error processing chunk ${chunkIndex}:`, error);
    
    // Check if session is still valid before continuing
    if (!currentChunkSession || currentChunkSession.id !== sessionId) {
      console.log(`🛑 Session cancelled - not continuing after error`);
      return;
    }
    
    // For non-recoverable errors, clean up the session
    if (error.message && (
      error.message.includes('No text provided') ||
      error.message.includes('No voice specified') ||
      error.message.includes('Invalid speed value')
    )) {
      console.log(`🛑 Non-recoverable error - cleaning up chunk session ${sessionId}`);
      currentChunkSession = null;
      
      // Update state to stopped
      currentPlayerState = 'stopped';
      chrome.runtime.sendMessage({
        type: 'playerStateUpdate',
        state: 'stopped'
      }).catch(() => {});
      
      return;
    }
    
    // Continue with next chunk on recoverable errors
    currentChunkSession.currentIndex++;
    if (currentChunkSession.currentIndex < currentChunkSession.chunks.length) {
      setTimeout(() => processNextChunk(sessionId), 500);
    } else {
      // No more chunks to process, clean up
      console.log(`🛑 No more chunks to process after error - cleaning up session ${sessionId}`);
      currentChunkSession = null;
    }
  }
}

// Process and read text with default settings
async function processAndReadText(htmlAndTextResult, tabId) {
  console.log(`processAndReadText: htmlAndTextResult=${JSON.stringify(htmlAndTextResult)}`)
  try {
    // Initialize chunker if needed
    initializeTextChunker();
    
    // If already processing or playing, stop current audio first
    if (currentPlayerState === 'loading' || currentPlayerState === 'playing') {
      chrome.runtime.sendMessage({ type: 'stopAllAudio' });
      currentPlayerState = 'stopped';
      
      // Abort any active fetch requests
      if (activeAbortController) {
        console.log(`🛑 Aborting previous TTS request`);
        activeAbortController.abort();
        activeAbortController = null;
      }
      
      currentChunkSession = null;
      // Give a brief moment for the stop to process
      await new Promise(resolve => setTimeout(resolve, 100));
    } else if (currentChunkSession) {
      // Clean up any stale chunk session even if not actively playing
      console.log(`🛑 Cleaning up stale chunk session ${currentChunkSession.id}`);
      currentChunkSession = null;
      
      // Also clean up any stale abort controller
      if (activeAbortController) {
        activeAbortController.abort();
        activeAbortController = null;
      }
    }
    // Get default settings (same as popup.js)
    const savedSettings = await chrome.storage.local.get({
      serverUrl: 'http://localhost:8000/v1/audio/speech',
      voice: 'af_bella',
      speed: 1.0,
      recordAudio: false,
      preprocessText: true,
      enableChunking: true,
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
    let text = htmlAndTextResult.text
    console.log(`processAndReadText: initial innerText=${JSON.stringify(text)}`)

    const html = htmlAndTextResult.html
    if (settings.preprocessText && tabId) {
      // Convert html text to markdown.
      if (!!html) {
        console.log(`Has html to convert to markdown: ${html}`)
        // Convert html to markdown and use that as text to retain structure.
        try {
          const checkResult = await chrome.scripting.executeScript({
            target: { tabId: tabId },
            func: () => typeof window.HtmlToMarkdown !== 'undefined'
          });
          if (!checkResult[0].result) {
            // Inject the html to markdown script only if it doesn't exist
            console.log(`Initializing htmlToMarkdown.js`)
            await chrome.scripting.executeScript({
              target: { tabId: tabId },
              files: ['htmlToMarkdown.js']
            });
          }
          const markdownResult = await chrome.scripting.executeScript({
            target: { tabId: tabId },
            func: (htmlToProcess) => {
              return window.HtmlToMarkdown.convert(htmlToProcess);
            },
            args: [html]
          });
          if (markdownResult && markdownResult[0] && markdownResult[0].result) {
            text = markdownResult[0].result;
            console.log(`✅ Got result from HtmlToMarkdown: ${text}`)
          } else {
            console.log(`❌ No result from HtmlToMarkdown`)
          }
        } catch(error) {
          console.error('❌ Error from HtmlToMarkdown:', error);
        }
      }

      try {
        // Check if TextProcessor already exists, if not inject it
        const checkResult = await chrome.scripting.executeScript({
          target: { tabId: tabId },
          func: () => typeof window.TextProcessor !== 'undefined'
        });
        
        if (!checkResult[0].result) {
          // Inject the text processor script only if it doesn't exist
          await chrome.scripting.executeScript({
            target: { tabId: tabId },
            files: ['textProcessor.js']
          });
        }
        
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
          console.log(`✅ Got result from TextProcessor: ${text}`)
        } else {
          console.log(`❌ No result from TextProcessor`)
        }
      } catch (error) {
        console.error('❌ Error from TextProcessor:', error);
        // Fall back to using the original text
      }
    }
    
    // Check if chunking is enabled
    if (settings.enableChunking) {
      // Chunk the text for better performance
      const chunks = textChunker.chunkText(text);
      
      if (chunks.length === 0) {
        // Clean up any stale state before throwing error
        currentChunkSession = null;
        if (activeAbortController) {
          activeAbortController.abort();
          activeAbortController = null;
        }
        throw new Error('No text to process after chunking');
      }
      
      // Create a new chunk session
      currentChunkSession = {
        id: Date.now(),
        chunks: chunks,
        currentIndex: 0,
        settings: settings,
        totalChunks: chunks.length,
        startTime: Date.now(),
        chunkTimings: {}
      };
      
      console.log(`📝 Text chunked into ${chunks.length} parts:`, chunks.map((chunk, i) => `Chunk ${i}: ${chunk.substring(0, 50)}...`));
      
      // Set state to loading
      currentPlayerState = 'loading';
      chrome.runtime.sendMessage({ 
        type: 'playerStateUpdate', 
        state: 'loading' 
      }).catch(() => {
        // Ignore connection errors when popup is not open
      });
      
      // Initialize audio queue in offscreen document
      await setupOffscreenDocument();
      chrome.runtime.sendMessage({ 
        type: 'initAudioQueue',
        sessionId: currentChunkSession.id,
        totalChunks: chunks.length
      });
      
      // Start processing chunks
      processNextChunk(currentChunkSession.id);
    } else {
      // Use legacy single audio processing
      console.log(`📝 Processing text as single audio (${text.length} characters)`);
      
      // Set state to loading
      currentPlayerState = 'loading';
      chrome.runtime.sendMessage({ 
        type: 'playerStateUpdate', 
        state: 'loading' 
      }).catch(() => {
        // Ignore connection errors when popup is not open
      });
      
      // Use the legacy streaming function
      await startStreamingAudioLegacy(text, settings);
    }
  } catch (error) {
    console.error('Error in processAndReadText:', error);
    
    // Reset state to stopped on any error
    currentPlayerState = 'stopped';
    
    // Clean up chunk session
    if (currentChunkSession) {
      console.log(`🛑 Cleaning up chunk session ${currentChunkSession.id} due to error`);
      currentChunkSession = null;
    }
    
    // Abort any active fetch requests
    if (activeAbortController) {
      console.log(`🛑 Aborting active TTS request due to error`);
      activeAbortController.abort();
      activeAbortController = null;
    }
    
    chrome.runtime.sendMessage({ 
      type: 'playerStateUpdate', 
      state: 'stopped' 
    }).catch(() => {
      // Ignore connection errors when popup is not open
    });
    
    chrome.runtime.sendMessage({ 
      type: 'streamError', 
      error: error.message 
    }).catch(() => {
      // Ignore connection errors when popup is not open
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
      // Use the processAndReadText function which now handles chunking
      processAndReadText(message.text, null);
      sendResponse({ success: true });
      return true;
      
    case 'controlAudio':
      chrome.runtime.sendMessage({ 
        type: message.action, 
        data: message.data 
      });
      return true;
      
    case 'stop':
      // Handle stop command - stop chunked audio
      chrome.runtime.sendMessage({ type: 'stopAllAudio' });
      currentPlayerState = 'stopped';
      
      // Abort any active fetch requests
      if (activeAbortController) {
        console.log(`🛑 Aborting active TTS request`);
        activeAbortController.abort();
        activeAbortController = null;
      }
      
      // Clear chunk session after aborting requests
      if (currentChunkSession) {
        console.log(`🛑 Stopping chunk session ${currentChunkSession.id}`);
        logPerformanceSummary();
        currentChunkSession = null;
      }
      
      chrome.runtime.sendMessage({ 
        type: 'playerStateUpdate', 
        state: 'stopped' 
      }).catch(() => {
        // Ignore connection errors when popup is not open
      });
      return true;
      
    case 'pause':
      // Forward pause to offscreen
      chrome.runtime.sendMessage({ type: 'pause' });
      return true;
      
    case 'play':
      // Forward play to offscreen
      chrome.runtime.sendMessage({ type: 'play' });
      return true;
      
    case 'stateUpdate':
      currentPlayerState = message.state;
      // Clear chunk session when stopped and log performance summary
      if (message.state === 'stopped' && currentChunkSession) {
        logPerformanceSummary();
        currentChunkSession = null;
      }
      chrome.runtime.sendMessage({ 
        type: 'playerStateUpdate', 
        state: message.state 
      }).catch(() => {
        // Ignore connection errors when popup is not open
      });
      return true;
      
    case 'audioReady':
      // Audio is ready but not yet playing
      if (currentPlayerState === 'loading') {
        currentPlayerState = 'ready';
        chrome.runtime.sendMessage({ 
          type: 'playerStateUpdate', 
          state: 'ready' 
        }).catch(() => {
          // Ignore connection errors when popup is not open
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
      chrome.runtime.sendMessage(message).catch(() => {
        // Ignore connection errors when popup is not open
      });
      return true;
  }
});

// Start streaming audio as single file (legacy mode)
async function startStreamingAudioLegacy(text, settings) {
  try {
    await setupOffscreenDocument();
    
    // Validate request parameters
    if (!text || text.trim().length === 0) {
      throw new Error('No text provided for TTS');
    }

    if (!settings.voice || settings.voice.trim().length === 0) {
      throw new Error('No voice specified for TTS');
    }

    const speed = parseFloat(settings.speed);
    if (isNaN(speed) || speed <= 0 || speed > 4) {
      throw new Error(`Invalid speed value: ${settings.speed}`);
    }

    const requestBody = {
      model: 'tts-1',
      voice: settings.voice.trim(),
      input: text.trim(),
      speed: speed
    };
    
    console.log(`📤 Sending text to TTS server as single audio:`, {
      textLength: text.length,
      voice: settings.voice,
      speed: speed,
      serverUrl: settings.serverUrl
    });
    
    const requestStartTime = Date.now();
    const response = await fetch(settings.serverUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Accept': 'audio/mpeg, audio/wav, audio/*'
      },
      body: JSON.stringify(requestBody)
    });
    
    const requestEndTime = Date.now();
    console.log(`📥 TTS server response:`, {
      status: response.status,
      requestTime: `${requestEndTime - requestStartTime}ms`,
      contentType: response.headers.get('content-type')
    });

    if (!response.ok) {
      throw new Error(`HTTP error! status: ${response.status}`);
    }

    // Get the audio data as a blob
    const audioBlob = await response.blob();
    if (audioBlob.size === 0) {
      throw new Error('Received empty audio data from server');
    }

    const mimeType = audioBlob.type || 'audio/mpeg';
    if (!mimeType.startsWith('audio/')) {
      throw new Error(`Invalid audio format received: ${mimeType}`);
    }
    
    // Convert blob to array buffer to send to offscreen document
    const arrayBuffer = await audioBlob.arrayBuffer();
    if (arrayBuffer.byteLength === 0) {
      throw new Error('Audio data is empty');
    }
    
    console.log(`✅ Single audio processed (${Math.round(arrayBuffer.byteLength / 1024)}KB audio)`);
    
    // Send the audio data to the offscreen document using legacy method
    chrome.runtime.sendMessage({ 
      type: 'processAudioData', 
      audioData: Array.from(new Uint8Array(arrayBuffer)),
      mimeType: mimeType,
      isRecording: isRecording
    });
    
    console.log(`📨 Sent single audio to offscreen (${Math.round(arrayBuffer.byteLength / 1024)}KB)`);
  } catch (error) {
    console.error('Error streaming audio:', error);
    chrome.runtime.sendMessage({ 
      type: 'streamError', 
      error: error.message 
    }).catch(() => {
      // Ignore connection errors when popup is not open
    });
    
    // Update state to stopped on error
    currentPlayerState = 'stopped';
    chrome.runtime.sendMessage({ 
      type: 'playerStateUpdate', 
      state: 'stopped' 
    }).catch(() => {
      // Ignore connection errors when popup is not open
    });
  }
}

// Start streaming audio chunk from the TTS server
async function startStreamingAudioChunk(text, settings, chunkIndex, sessionId) {
  try {
    await setupOffscreenDocument();
    
    // Check if session is still valid
    if (!currentChunkSession || currentChunkSession.id !== sessionId) {
      console.log(`🛑 Session cancelled before starting chunk ${chunkIndex}`);
      return;
    }
    
    // Validate request parameters
    if (!text || text.trim().length === 0) {
      throw new Error('No text provided for TTS');
    }

    if (!settings.voice || settings.voice.trim().length === 0) {
      throw new Error('No voice specified for TTS');
    }

    const speed = parseFloat(settings.speed);
    if (isNaN(speed) || speed <= 0 || speed > 4) {
      throw new Error(`Invalid speed value: ${settings.speed}`);
    }

    const requestBody = {
      model: 'tts-1',
      voice: settings.voice.trim(),
      input: text.trim(),
      speed: speed
    };
    
    console.log(`📤 Sending chunk ${chunkIndex} to TTS server:`, {
      textLength: text.length,
      voice: settings.voice,
      speed: speed,
      serverUrl: settings.serverUrl
    });
    
    // Create AbortController for this request
    const abortController = new AbortController();
    activeAbortController = abortController;
    
    const requestStartTime = Date.now();
    const response = await fetch(settings.serverUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Accept': 'audio/mpeg, audio/wav, audio/*'
      },
      body: JSON.stringify(requestBody),
      signal: abortController.signal
    });
    
    const requestEndTime = Date.now();
    console.log(`📥 TTS server response for chunk ${chunkIndex}:`, {
      status: response.status,
      requestTime: `${requestEndTime - requestStartTime}ms`,
      contentType: response.headers.get('content-type')
    });

    // Check if session is still valid after fetch
    if (!currentChunkSession || currentChunkSession.id !== sessionId) {
      console.log(`🛑 Session cancelled while fetching chunk ${chunkIndex} - discarding response`);
      return;
    }

    if (!response.ok) {
      throw new Error(`HTTP error! status: ${response.status}`);
    }

    // Get the audio data as a blob
    const audioBlob = await response.blob();
    if (audioBlob.size === 0) {
      throw new Error('Received empty audio data from server');
    }

    // Check again if session is still valid after blob conversion
    if (!currentChunkSession || currentChunkSession.id !== sessionId) {
      console.log(`🛑 Session cancelled while processing chunk ${chunkIndex} blob - discarding response`);
      return;
    }

    const mimeType = audioBlob.type || 'audio/mpeg';
    if (!mimeType.startsWith('audio/')) {
      throw new Error(`Invalid audio format received: ${mimeType}`);
    }
    
    // Convert blob to array buffer to send to offscreen document
    const arrayBuffer = await audioBlob.arrayBuffer();
    if (arrayBuffer.byteLength === 0) {
      throw new Error('Audio data is empty');
    }
    
    // Final check if session is still valid before sending to offscreen
    if (!currentChunkSession || currentChunkSession.id !== sessionId) {
      console.log(`🛑 Session cancelled while processing chunk ${chunkIndex} audio data - discarding response`);
      return;
    }
    
    // Record completion time for this chunk
    if (currentChunkSession && currentChunkSession.chunkTimings[chunkIndex]) {
      currentChunkSession.chunkTimings[chunkIndex].completedTime = Date.now();
      const processingTime = currentChunkSession.chunkTimings[chunkIndex].completedTime - 
                            currentChunkSession.chunkTimings[chunkIndex].startTime;
      console.log(`✅ Chunk ${chunkIndex} processed in ${processingTime}ms (${Math.round(arrayBuffer.byteLength / 1024)}KB audio)`);
    }
    
    // Send the audio data to the offscreen document
    try {
      chrome.runtime.sendMessage({ 
        type: 'processAudioChunk', 
        audioData: Array.from(new Uint8Array(arrayBuffer)),
        mimeType: mimeType,
        isRecording: isRecording,
        chunkIndex: chunkIndex,
        sessionId: sessionId,
        totalChunks: currentChunkSession?.totalChunks || 1
      });
    } catch (sendError) {
      console.error(`❌ Error sending chunk ${chunkIndex} to offscreen:`, sendError);
      // Try to recreate offscreen document if sending fails
      await setupOffscreenDocument();
      chrome.runtime.sendMessage({ 
        type: 'processAudioChunk', 
        audioData: Array.from(new Uint8Array(arrayBuffer)),
        mimeType: mimeType,
        isRecording: isRecording,
        chunkIndex: chunkIndex,
        sessionId: sessionId,
        totalChunks: currentChunkSession?.totalChunks || 1
      });
    }
    
    console.log(`📨 Sent chunk ${chunkIndex} audio to offscreen (${Math.round(arrayBuffer.byteLength / 1024)}KB)`);
  } catch (error) {
    // Clear the active abort controller
    if (activeAbortController) {
      activeAbortController = null;
    }
    
    // Handle abort errors differently (don't log as errors when user stops)
    if (error.name === 'AbortError') {
      console.log(`🛑 Chunk ${chunkIndex} request aborted (user stopped audio)`);
      return;
    }
    
    console.error(`❌ Error streaming audio for chunk ${chunkIndex}:`, error);
    
    // Only send error messages if session is still active
    if (currentChunkSession && currentChunkSession.id === sessionId) {
      chrome.runtime.sendMessage({ 
        type: 'streamError', 
        error: error.message 
      }).catch(() => {
        // Ignore connection errors when popup is not open
      });
      
      // Update state to stopped on error
      currentPlayerState = 'stopped';
      chrome.runtime.sendMessage({ 
        type: 'playerStateUpdate', 
        state: 'stopped' 
      }).catch(() => {
        // Ignore connection errors when popup is not open
      });
      
      // Clean up the chunk session on non-abort errors
      if (error.name !== 'AbortError') {
        console.log(`🛑 Cleaning up chunk session ${currentChunkSession.id} due to streaming error`);
        currentChunkSession = null;
      }
    }
  }
}

// Handle keyboard commands
chrome.commands.onCommand.addListener(async (command) => {
  if (command === 'read-aloud') {
    const tabs = await chrome.tabs.query({active: true, currentWindow: true});
    const [tab] = tabs;
    
    if (!tab) return;
    
    // Use the same text extraction logic as popup
    try {
      // Inject the shared text extractor
      await chrome.scripting.executeScript({
        target: { tabId: tab.id },
        files: ['textExtractor.js']
      });
      
      // Get page data using the shared extractor
      const pageDataResult = await chrome.scripting.executeScript({
        target: { tabId: tab.id },
        function: () => window.extractPageText()
      });
      
      if (pageDataResult && pageDataResult[0] && pageDataResult[0].result) {
        processAndReadText(pageDataResult[0].result, tab.id);
      }
    } catch (error) {
      console.error('Error executing script for hotkey:', error);
    };
  } else if (command === 'stop-audio') {
    // Stop audio playback using the chunked audio stop mechanism
    chrome.runtime.sendMessage({ type: 'stopAllAudio' });
    currentPlayerState = 'stopped';
    
    // Abort any active fetch requests
    if (activeAbortController) {
      console.log(`🛑 Aborting active TTS request (hotkey)`);
      activeAbortController.abort();
      activeAbortController = null;
    }
    
    // Clear chunk session after aborting requests
    if (currentChunkSession) {
      console.log(`🛑 Stopping chunk session ${currentChunkSession.id} (hotkey)`);
      logPerformanceSummary();
      currentChunkSession = null;
    }
    
    chrome.runtime.sendMessage({ 
      type: 'playerStateUpdate', 
      state: 'stopped' 
    }).catch(() => {
      // Ignore connection errors when popup is not open
    });
  }
});

// Initialize context menu when extension is installed or updated
chrome.runtime.onInstalled.addListener(() => {
  setupContextMenu();
});