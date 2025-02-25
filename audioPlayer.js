class AudioPlayer {
    constructor() {
      this.isPlaying = false;
      this.isInitialized = false;
    }
  
    async init() {
      if (!this.isInitialized) {
        // Set up the offscreen document for background playback
        await chrome.runtime.sendMessage({ type: 'setupOffscreen' });
        this.isInitialized = true;
      }
    }
  
    async play(text, settings) {
      await this.init();
      
      try {
        // Start streaming audio
        await chrome.runtime.sendMessage({ 
          type: 'startStreaming', 
          text: text, 
          settings: settings,
          record: settings.recordAudio
        });
        
        this.isPlaying = true;
        return true;
      } catch (error) {
        console.error('Error playing audio:', error);
        throw error;
      }
    }
  
    pause() {
      if (this.isInitialized) {
        chrome.runtime.sendMessage({ type: 'pause' });
        this.isPlaying = false;
      }
    }
  
    resume() {
      if (this.isInitialized) {
        chrome.runtime.sendMessage({ type: 'play' });
        this.isPlaying = true;
      }
    }
  
    stop() {
      if (this.isInitialized) {
        chrome.runtime.sendMessage({ type: 'stop' });
        this.isPlaying = false;
      }
    }
  
    async getState() {
      return new Promise((resolve) => {
        chrome.runtime.sendMessage({ type: 'getPlayerState' }, (response) => {
          resolve(response.state || 'stopped');
        });
      });
    }
  }
  
  window.AudioPlayer = AudioPlayer;