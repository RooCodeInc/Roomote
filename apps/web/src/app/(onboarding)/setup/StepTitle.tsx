export function StepTitle({
  text,
  className,
  showCheckbox = false,
}: {
  text: string;
  className?: string;
  showCheckbox?: boolean;
}) {
  return (
    <h2
      className={`text-3xl font-bold tracking-tighter relative ${className ?? ''}`}
    >
      <span
        className={`relative flex gap-3 items-center ${showCheckbox && 'md:left-[-37px]'}`}
      >
        <span className="absolute -left-6 border-foreground border rounded-lg w-3 hidden md:inline-block bg-accent-bright-foreground" />
        {text}
      </span>
    </h2>
  );
}
