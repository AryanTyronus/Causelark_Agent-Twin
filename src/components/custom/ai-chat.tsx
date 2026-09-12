// @polsia:user-owned
'use client';

import { SendHorizontal } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { useChat } from '@/lib/ai/use-chat';

export interface AiChatProps {
  title?: string;
  placeholder?: string;
  /** Optional system prompt prepended to every request. */
  systemPrompt?: string;
}

// Presentational chat shell. All chat logic (state, streaming, message ids)
// lives in useChat() — restyle the markup below freely, but READ messages from
// the hook; do not rebuild the streaming/state here.
export function AiChat({
  title = 'Assistant',
  placeholder = 'Ask anything…',
  systemPrompt,
}: AiChatProps) {
  const { messages, input, setInput, pending, send } = useChat({ systemPrompt });

  return (
    <Card className="flex h-full max-h-[600px] w-full flex-col border-border/70 shadow-sm">
      <CardHeader className="pb-3">
        <CardTitle className="text-base font-semibold">{title}</CardTitle>
      </CardHeader>
      <CardContent className="flex min-h-0 flex-1 flex-col gap-4">
        <div className="flex min-h-0 flex-1 flex-col gap-3 overflow-y-auto pr-1">
          {messages.length === 0 ? (
            <p className="text-sm text-muted-foreground">{placeholder}</p>
          ) : (
            messages.map((m) => (
              <div
                key={m.id}
                className={
                  m.role === 'user'
                    ? 'ml-auto max-w-[85%] rounded-lg bg-secondary px-3 py-2 text-sm text-secondary-foreground'
                    : 'mr-auto max-w-[85%] whitespace-pre-wrap rounded-lg bg-muted px-3 py-2 text-sm text-foreground'
                }
              >
                {m.content || (pending ? '…' : '')}
              </div>
            ))
          )}
        </div>
        <form
          className="flex items-end gap-2"
          onSubmit={(e) => {
            e.preventDefault();
            send();
          }}
        >
          <textarea
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && !e.shiftKey) {
                e.preventDefault();
                send();
              }
            }}
            rows={1}
            placeholder={placeholder}
            className="min-h-10 flex-1 resize-none rounded-md border border-input bg-background px-3 py-2 text-sm shadow-sm outline-none focus-visible:ring-1 focus-visible:ring-ring"
          />
          <Button type="submit" size="icon" disabled={pending || !input.trim()} aria-label="Send">
            <SendHorizontal className="size-4" aria-hidden="true" />
          </Button>
        </form>
      </CardContent>
    </Card>
  );
}
