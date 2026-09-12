// @polsia:framework-owned - DO NOT EDIT. Code installed by polsia/modules/ai@0.1.0. Drift = commit rejected.
//
// Streaming chat state hook. Owns ALL the fragile chat logic — message state,
// the POST to /api/ai/chat, SSE parsing, and the token-by-token optimistic
// update — so the chat UI (src/components/custom/ai-chat.tsx) can stay a pure
// presentational shell. Every message carries a stable `id` (use it as the
// React key). The shell NEVER constructs a message, so it cannot break the
// message contract. Do NOT reimplement this in the component — call useChat()
// and render what it returns.
'use client';

import { useRef, useState } from 'react';

export interface UiMessage {
  id: string;
  role: 'user' | 'assistant';
  content: string;
}

export interface UseChatOptions {
  /** Prepended to every request as a system message. */
  systemPrompt?: string;
  /** Streaming chat endpoint. Defaults to the ai module's route. */
  api?: string;
}

export interface UseChat {
  messages: UiMessage[];
  input: string;
  setInput: (value: string) => void;
  pending: boolean;
  /** Send the current input. Safe to call from a form onSubmit. */
  send: () => void;
  /** Abort the in-flight response, if any. */
  stop: () => void;
}

// Browser-only hook (`'use client'`): crypto.randomUUID is always present in a
// secure context (https / localhost).
function newId(): string {
  return crypto.randomUUID();
}

export function useChat(options: UseChatOptions = {}): UseChat {
  const { systemPrompt, api = '/api/ai/chat' } = options;
  const [messages, setMessages] = useState<UiMessage[]>([]);
  const [input, setInput] = useState('');
  const [pending, setPending] = useState(false);
  const abortRef = useRef<AbortController | null>(null);

  function stop() {
    abortRef.current?.abort();
    abortRef.current = null;
  }

  async function run() {
    const text = input.trim();
    if (!text || pending) return;

    const userMessage: UiMessage = { id: newId(), role: 'user', content: text };
    const history = [...messages, userMessage];
    setMessages(history);
    setInput('');
    setPending(true);

    const controller = new AbortController();
    abortRef.current = controller;

    try {
      const res = await fetch(api, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          messages: [
            ...(systemPrompt ? [{ role: 'system', content: systemPrompt }] : []),
            ...history.map((m) => ({ role: m.role, content: m.content })),
          ],
        }),
        signal: controller.signal,
      });

      if (!res.ok || !res.body) {
        setMessages((m) => [
          ...m,
          { id: newId(), role: 'assistant', content: 'Something went wrong. Please try again.' },
        ]);
        return;
      }

      // Stream the OpenAI-compatible SSE response token by token into one
      // assistant message, identified by its stable id.
      const assistantId = newId();
      setMessages((m) => [...m, { id: assistantId, role: 'assistant', content: '' }]);

      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buffer = '';

      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split('\n');
        buffer = lines.pop() ?? '';
        for (const line of lines) {
          const trimmed = line.trim();
          if (!trimmed.startsWith('data:')) continue;
          const data = trimmed.slice(5).trim();
          if (!data || data === '[DONE]') continue;
          try {
            const token = JSON.parse(data)?.choices?.[0]?.delta?.content;
            if (typeof token === 'string' && token) {
              setMessages((m) =>
                m.map((msg) =>
                  msg.id === assistantId ? { ...msg, content: msg.content + token } : msg,
                ),
              );
            }
          } catch {
            // Ignore keep-alive / non-JSON lines.
          }
        }
      }
    } catch {
      // Aborted or network error — leave the conversation as-is.
    } finally {
      setPending(false);
      abortRef.current = null;
    }
  }

  return {
    messages,
    input,
    setInput,
    pending,
    send: () => void run(),
    stop,
  };
}
