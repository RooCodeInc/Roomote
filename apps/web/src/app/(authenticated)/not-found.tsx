export default function NotFound() {
  const bgImageUrl =
    'bg-[url(/elements/splatter-black.webp)] dark:bg-[url(/elements/splatter-accent.webp)]';

  return (
    <div className="flex min-h-0 w-full flex-1 items-center justify-center p-6">
      <div
        className={`font-bold tracking-tighter text-[80px] text-center text-accent-bright-foreground dark:text-card pt-18 pb-10 ${bgImageUrl} aspect-8/3 bg-cover bg-center w-90`}
      >
        404
      </div>
    </div>
  );
}
