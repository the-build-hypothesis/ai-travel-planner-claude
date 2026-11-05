import { useEffect, useRef, useState, type ReactNode } from 'react';
import { ArrowUp, Check, Info, RotateCcw, Sparkles } from 'lucide-react';
import type { ChatMessage, PlaceCard, Trip } from '../api';
import { Alert, IconButton } from '../ui';
import { PlaceCardView } from './PlaceCardView';

/** Renders simple bullets and bold as React nodes. Model text is never treated as HTML. */
function RichText({ text }: { text: string }) {
  const inline = (line: string): ReactNode[] => line.split(/(\*\*[^*]+\*\*)/g).map((part, i) => (part.startsWith('**') && part.endsWith('**') ? <strong key={i}>{part.slice(2, -2)}</strong> : part));
  const blocks: ReactNode[] = [];
  let bullets: string[] = [];
  const flush = () => {
    if (bullets.length) {
      const items = bullets;
      blocks.push(<ul key={blocks.length} className="my-1.5 list-disc space-y-0.5 pl-5">{items.map((b, i) => <li key={i}>{inline(b)}</li>)}</ul>);
      bullets = [];
    }
  };
  for (const line of text.split('\n')) {
    const bullet = /^\s*[-•*]\s+(.*)$/.exec(line);
    if (bullet) {
      bullets.push(bullet[1]);
      continue;
    }
    flush();
    if (line.trim()) blocks.push(<p key={blocks.length} className="my-1 first:mt-0 last:mb-0">{inline(line)}</p>);
  }
  flush();
  return <>{blocks}</>;
}

const STARTERS = ['Plan five days in Tokyo for a family of four', 'A relaxed long weekend in Lisbon', 'Where is warm in February?'];

export interface ChatProps {
  trip: Trip;
  messages: ChatMessage[];
  streamingText: string;
  status: string | null;
  busy: boolean;
  error: { message: string; retry: string | null } | null;
  onSend: (text: string) => void;
  renderPlaceAction: (place: PlaceCard) => ReactNode;
}

export function ChatPanel({ trip, messages, streamingText, status, busy, error, onSend, renderPlaceAction }: ChatProps) {
  const [text, setText] = useState('');
  const scroller = useRef<HTMLDivElement>(null);
  const input = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    const el = scroller.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [messages.length, streamingText, status, error]);

  function submit(value = text) {
    const content = value.trim();
    if (!content || busy) return;
    onSend(content);
    setText('');
    if (input.current) input.current.style.height = 'auto';
  }

  const last = messages.at(-1);
  const suggestions = !busy && last?.role === 'assistant' ? (last.meta?.suggestions ?? []) : [];
  const hasDays = trip.itinerary.days.length > 0;

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div ref={scroller} className="min-h-0 flex-1 space-y-4 overflow-y-auto px-4 py-5" aria-live="polite" aria-relevant="additions">
        {messages.length === 0 && !busy && (
          <div className="rise pt-4 text-center">
            <div className="mx-auto mb-3 grid size-12 place-items-center rounded-2xl bg-accent-soft text-accent"><Sparkles className="size-6" aria-hidden /></div>
            <h2 className="text-xl font-semibold">Where are you dreaming of?</h2>
            <p className="mt-1 text-sm text-ink-soft">Tell me about your trip in your own words.</p>
            <div className="mt-4 flex flex-col items-center gap-2">
              {STARTERS.map((s) => <button key={s} type="button" onClick={() => submit(s)} className="cursor-pointer rounded-full border border-line bg-surface px-3.5 py-1.5 text-[13px] font-medium text-ink-soft hover:border-teal hover:text-teal">{s}</button>)}
            </div>
          </div>
        )}
        {messages.map((m) =>
          m.role === 'user' ? (
            <div key={m.id} className="rise flex justify-end">
              <p className="max-w-[88%] rounded-2xl rounded-br-md bg-teal px-3.5 py-2.5 text-[15px] leading-relaxed break-words whitespace-pre-wrap text-white">{m.content}</p>
            </div>
          ) : (
            <div key={m.id} className="rise">
              <div className="text-[15px] leading-relaxed break-words"><RichText text={m.content} /></div>
              {m.meta?.changes && m.meta.changes.length > 0 && (
                <ul className="mt-2 flex flex-wrap gap-1.5" aria-label="Changes made">
                  {m.meta.changes.map((c, i) => <li key={i} className="flex max-w-full items-center gap-1 rounded-full bg-verified-soft px-2.5 py-0.5 text-[12px] font-medium text-verified"><Check className="size-3 shrink-0" aria-hidden /><span className="truncate">{changeLabel(c)}</span></li>)}
                </ul>
              )}
              {m.meta?.notes?.map((note) => <p key={note} className="mt-2 flex gap-1.5 rounded-lg bg-estimate-soft px-2.5 py-1.5 text-[13px] text-estimate"><Info className="mt-0.5 size-3.5 shrink-0" aria-hidden />{note}</p>)}
              {m.meta?.places && m.meta.places.length > 0 && (
                <ul className="mt-3 space-y-2">
                  {m.meta.places.map((place) => <li key={place.place_id}><PlaceCardView place={place} action={renderPlaceAction(place)} /></li>)}
                </ul>
              )}
            </div>
          ),
        )}
        {streamingText && <div className="text-[15px] leading-relaxed break-words"><RichText text={streamingText} /></div>}
        {status && (
          <div role="status" className="flex items-center gap-2 text-sm text-ink-soft">
            <span className="flex gap-1" aria-hidden><span className="dot size-1.5 rounded-full bg-accent" /><span className="dot size-1.5 rounded-full bg-accent" /><span className="dot size-1.5 rounded-full bg-accent" /></span>
            {status}
          </div>
        )}
        {error && (
          <Alert>
            {error.message}
            {error.retry && <> <button type="button" className="inline-flex cursor-pointer items-center gap-1 font-semibold underline" onClick={() => onSend(error.retry!)}><RotateCcw className="size-3" aria-hidden />Try again</button></>}
          </Alert>
        )}
      </div>
      <div className="border-t border-line bg-surface/70 p-3">
        {suggestions.length > 0 && (
          <div className="mb-2 flex gap-1.5 overflow-x-auto pb-1">
            {suggestions.map((s) => <button key={s} type="button" onClick={() => submit(s)} className="shrink-0 cursor-pointer rounded-full border border-line bg-surface px-3 py-1 text-[13px] font-medium text-ink-soft hover:border-teal hover:text-teal">{s}</button>)}
          </div>
        )}
        <form
          className="flex items-end gap-2 rounded-2xl border border-line bg-surface p-1.5 focus-within:border-teal focus-within:ring-2 focus-within:ring-teal/20"
          onSubmit={(e) => {
            e.preventDefault();
            submit();
          }}
        >
          <label htmlFor="chat-input" className="sr-only">Message the planning assistant</label>
          <textarea
            id="chat-input"
            ref={input}
            rows={1}
            maxLength={2000}
            value={text}
            placeholder={hasDays ? 'Ask for a change…' : 'Describe your trip…'}
            onChange={(e) => {
              setText(e.target.value);
              e.target.style.height = 'auto';
              e.target.style.height = `${Math.min(e.target.scrollHeight, 140)}px`;
            }}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && !e.shiftKey) {
                e.preventDefault();
                submit();
              }
            }}
            className="max-h-36 min-w-0 flex-1 resize-none bg-transparent px-2.5 py-2 text-[15px] placeholder:text-muted focus:outline-none"
          />
          <IconButton label="Send message" type="submit" disabled={busy || !text.trim()} className="size-9! shrink-0 rounded-xl! bg-accent! text-white! hover:bg-accent-deep! disabled:bg-sand-deep!"><ArrowUp className="size-4.5" /></IconButton>
        </form>
      </div>
    </div>
  );
}

function changeLabel(c: { type: string; label: string; day_number?: number }): string {
  const verbs: Record<string, string> = { added: 'Added', removed: 'Removed', replaced: 'Replaced', updated: 'Updated', moved: 'Moved', day_removed: 'Removed', day_regenerated: 'Rewrote', day_added: 'Added', generated: 'Built' };
  return `${verbs[c.type] ?? 'Changed'} ${c.label}`;
}
