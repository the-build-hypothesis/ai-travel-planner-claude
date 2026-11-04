import { Link } from "react-router";
import { Compass } from "lucide-react";
import { Button, EmptyState } from "../components/ui";

export function NotFoundPage() {
  return (
    <div className="mx-auto max-w-xl px-4 py-20">
      <EmptyState icon={<Compass className="size-6" />} title="This page wandered off the map" action={<Link to="/"><Button>Back to planning</Button></Link>}>
        The page you're looking for doesn't exist or may have moved.
      </EmptyState>
    </div>
  );
}
