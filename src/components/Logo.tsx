export function Logo({ compact = false }: { compact?: boolean }) {
  return (
    <span className={`logo${compact ? " compact" : ""}`}>
      <svg
        width="27"
        height="24"
        viewBox="0 0 27 24"
        fill="none"
        aria-hidden="true"
      >
        <path
          d="m8 3 16 0-6 9H2l6-9Z"
          stroke="currentColor"
          strokeWidth="2.3"
        />
        <path d="M8 12 2 21h16l6-9" stroke="currentColor" strokeWidth="2.3" />
      </svg>
      <strong>镜流</strong>
      {!compact && <span>ContextFlow</span>}
    </span>
  );
}
