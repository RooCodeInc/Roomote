import { Check } from '@/components/system';

export function StepCompletedBadge({
  text,
  className,
}: {
  text: string;
  className?: string;
}) {
  return (
    <div
      className={`inline-flex gap-2 items-center px-0.5 py-0.5 border-b-2 tex-tblack border-black animate-[fade-in_0.5s_linear_0.5s_backwards_1] ${className ?? ''}`}
    >
      <span className="text-xs font-medium">{text}</span>
      <Check className="size-3 text-black" />
    </div>
  );
}
