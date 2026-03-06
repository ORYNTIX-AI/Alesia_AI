import { useEffect, useRef, useState } from 'react';

function getSpeechRecognitionConstructor() {
  if (typeof window === 'undefined') return null;
  return window.SpeechRecognition || window.webkitSpeechRecognition || null;
}

export function useSpeechSidecar({ enabled, onFinalTranscript, language = 'ru-RU' }) {
  const [isSupported] = useState(() => Boolean(getSpeechRecognitionConstructor()));
  const [isListening, setIsListening] = useState(false);
  const [interimTranscript, setInterimTranscript] = useState('');
  const [error, setError] = useState(null);
  const recognitionRef = useRef(null);
  const enabledRef = useRef(enabled);
  const onFinalTranscriptRef = useRef(onFinalTranscript);

  useEffect(() => {
    enabledRef.current = enabled;
    onFinalTranscriptRef.current = onFinalTranscript;
  }, [enabled, onFinalTranscript]);

  useEffect(() => {
    const Recognition = getSpeechRecognitionConstructor();

    if (!Recognition || !enabled) {
      if (recognitionRef.current) {
        recognitionRef.current.onresult = null;
        recognitionRef.current.onend = null;
        recognitionRef.current.onerror = null;
        recognitionRef.current.stop();
        recognitionRef.current = null;
      }
      return;
    }

    const recognition = new Recognition();
    recognition.lang = language;
    recognition.continuous = true;
    recognition.interimResults = true;
    recognition.maxAlternatives = 1;

    recognition.onstart = () => {
      setIsListening(true);
      setError(null);
    };

    recognition.onresult = (event) => {
      let interim = '';

      for (let index = event.resultIndex; index < event.results.length; index += 1) {
        const result = event.results[index];
        const transcript = result[0]?.transcript?.trim();
        if (!transcript) continue;

        if (result.isFinal) {
          onFinalTranscriptRef.current?.(transcript);
        } else {
          interim = transcript;
        }
      }

      setInterimTranscript(interim);
    };

    recognition.onerror = (event) => {
      if (event.error === 'no-speech' || event.error === 'aborted') {
        return;
      }
      setError(event.error || 'speech-sidecar-error');
    };

    recognition.onend = () => {
      setIsListening(false);
      setInterimTranscript('');

      if (enabledRef.current) {
        try {
          recognition.start();
        } catch {
          // Ignore duplicate starts on some browsers.
        }
      }
    };

    try {
      recognition.start();
      recognitionRef.current = recognition;
    } catch (startError) {
      Promise.resolve().then(() => {
        setError(startError.message || 'Не удалось запустить распознавание');
      });
    }

    return () => {
      recognition.onresult = null;
      recognition.onend = null;
      recognition.onerror = null;
      recognition.stop();
      recognitionRef.current = null;
    };
  }, [enabled, language]);

  return {
    isSupported,
    isListening,
    interimTranscript,
    error,
  };
}
