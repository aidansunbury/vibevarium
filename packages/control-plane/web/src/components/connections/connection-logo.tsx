export function ConnectionLogo({ displayName, logoUrl }: { displayName: string; logoUrl?: string }) {
  if (logoUrl === undefined) return null;
  return (
    <span className="flex size-6 shrink-0 items-center justify-center rounded-md border bg-white p-1">
      <img src={logoUrl} alt={`${displayName} logo`} className="size-full" />
    </span>
  );
}
