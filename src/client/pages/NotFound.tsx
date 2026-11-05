import { Compass } from 'lucide-react';
import { Link } from 'react-router-dom';
import { EmptyState } from '../ui';

export function NotFoundPage() {
  return (
    <EmptyState
      icon={<Compass className="size-7" />}
      title="This page has wandered off"
      action={<Link to="/" className="inline-block rounded-xl bg-accent px-5 py-2.5 text-sm font-semibold text-white hover:bg-accent-deep">Plan a trip</Link>}
    >
      The page you're looking for doesn't exist or has moved.
    </EmptyState>
  );
}
