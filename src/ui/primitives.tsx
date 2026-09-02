/**
 * Design-system primitives.
 *
 * Small on purpose: MusiX needs a consistent button, a consistent slider and a
 * consistent empty state, not a component library. Every one of these is
 * keyboard-reachable and carries a real accessible name, because half the
 * controls in a music player are icon-only (spec §39).
 */

import {
  forwardRef,
  useEffect,
  useId,
  useRef,
  useState,
  type ButtonHTMLAttributes,
  type InputHTMLAttributes,
  type ReactNode,
} from 'react';
import { clamp } from '@core/utils';

function cx(...classes: (string | false | null | undefined)[]): string {
  return classes.filter(Boolean).join(' ');
}

export { cx };

// ---------------------------------------------------------------------------
// Button
// ---------------------------------------------------------------------------

export type ButtonVariant = 'primary' | 'secondary' | 'ghost' | 'danger';
export type ButtonSize = 'sm' | 'md' | 'lg';

const VARIANTS: Record<ButtonVariant, string> = {
  primary: 'bg-accent text-accent-fg hover:bg-accent-hover active:brightness-95 shadow-sm',
  secondary:
    'bg-surface text-text border border-line hover:bg-surface-hover active:bg-surface-active',
  ghost: 'text-muted hover:text-text hover:bg-surface-hover',
  danger: 'bg-danger/12 text-danger border border-danger/35 hover:bg-danger/20',
};

const SIZES: Record<ButtonSize, string> = {
  sm: 'h-8 px-3 text-xs gap-1.5 rounded-lg',
  md: 'h-10 px-4 text-sm gap-2 rounded-xl',
  lg: 'h-12 px-6 text-base gap-2.5 rounded-xl',
};

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: ButtonVariant;
  size?: ButtonSize;
  loading?: boolean;
  icon?: ReactNode;
}

export const Button = forwardRef<HTMLButtonElement, ButtonProps>(function Button(
  { variant = 'secondary', size = 'md', loading, icon, className, children, disabled, ...rest },
  ref,
) {
  return (
    <button
      ref={ref}
      type={rest.type ?? 'button'}
      disabled={disabled || loading}
      className={cx(
        'inline-flex select-none items-center justify-center font-medium transition',
        'disabled:cursor-not-allowed disabled:opacity-50',
        VARIANTS[variant],
        SIZES[size],
        className,
      )}
      {...rest}
    >
      {loading ? <Spinner size={size === 'sm' ? 12 : 14} /> : icon}
      {children}
    </button>
  );
});

export interface IconButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  /** Required: an icon-only control with no label is invisible to a screen reader. */
  label: string;
  size?: number;
  variant?: 'ghost' | 'solid' | 'accent';
  active?: boolean;
}

export const IconButton = forwardRef<HTMLButtonElement, IconButtonProps>(function IconButton(
  { label, size = 36, variant = 'ghost', active, className, children, ...rest },
  ref,
) {
  return (
    <button
      ref={ref}
      type="button"
      aria-label={label}
      title={label}
      aria-pressed={active === undefined ? undefined : active}
      style={{ width: size, height: size }}
      className={cx(
        'inline-flex shrink-0 items-center justify-center rounded-full transition',
        'disabled:cursor-not-allowed disabled:opacity-40',
        variant === 'ghost' && 'text-muted hover:bg-surface-hover hover:text-text',
        variant === 'solid' && 'bg-surface text-text hover:bg-surface-hover',
        variant === 'accent' && 'bg-accent text-accent-fg hover:bg-accent-hover',
        active && variant === 'ghost' && 'text-accent',
        className,
      )}
      {...rest}
    >
      {children}
    </button>
  );
});

// ---------------------------------------------------------------------------
// Slider
// ---------------------------------------------------------------------------

export interface SliderProps extends Omit<InputHTMLAttributes<HTMLInputElement>, 'onChange'> {
  value: number;
  min?: number;
  max?: number;
  step?: number;
  label: string;
  /** Hide the thumb until hover — used for the seek bar. */
  ghost?: boolean;
  onValueChange(value: number): void;
  /** Fired once when a drag ends, for expensive commits like seeking. */
  onCommit?(value: number): void;
}

export function Slider({
  value,
  min = 0,
  max = 1,
  step = 0.001,
  label,
  ghost,
  onValueChange,
  onCommit,
  className,
  ...rest
}: SliderProps) {
  const fill = max > min ? ((clamp(value, min, max) - min) / (max - min)) * 100 : 0;
  // Guards against committing twice for one gesture, since both `pointerup`
  // and `lostpointercapture` normally fire at the end of a drag.
  const committed = useRef(false);

  /**
   * End of an interaction.
   *
   * `lostpointercapture` is the reliable signal, not `pointerup`: a range input
   * takes implicit pointer capture, so releasing the pointer anywhere — very
   * common when a drag drifts off the control — fires capture loss but not a
   * `pointerup` on the input. Listening only for `pointerup` left the caller
   * mid-drag forever: the seek bar froze at the dropped position and the seek
   * itself never happened.
   */
  const commit = (event: { currentTarget: HTMLInputElement }) => {
    if (!onCommit || committed.current) return;
    committed.current = true;
    onCommit(Number.parseFloat(event.currentTarget.value));
  };

  return (
    <input
      type="range"
      aria-label={label}
      value={value}
      min={min}
      max={max}
      step={step}
      // `--mx-fill` drives the track gradient; see styles/tokens.css.
      style={{ ['--mx-fill' as string]: `${fill}%` }}
      className={cx('mx-range', ghost && 'mx-range-ghost', className)}
      onChange={(event) => onValueChange(Number.parseFloat(event.target.value))}
      onPointerDown={() => {
        committed.current = false;
      }}
      onPointerUp={commit}
      onLostPointerCapture={commit}
      onKeyDown={() => {
        committed.current = false;
      }}
      onKeyUp={commit}
      {...rest}
    />
  );
}

// ---------------------------------------------------------------------------
// Feedback
// ---------------------------------------------------------------------------

export function Spinner({ size = 16, className }: { size?: number; className?: string }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      aria-hidden="true"
      className={cx('animate-spin', className)}
    >
      <circle cx="12" cy="12" r="9" stroke="currentColor" strokeOpacity="0.22" strokeWidth="3" />
      <path
        d="M21 12a9 9 0 0 0-9-9"
        stroke="currentColor"
        strokeWidth="3"
        strokeLinecap="round"
      />
    </svg>
  );
}

export interface ProgressBarProps {
  /** 0–1. */
  value: number;
  label?: string;
  className?: string;
  tone?: 'accent' | 'ok' | 'warn' | 'danger';
}

export function ProgressBar({ value, label, className, tone = 'accent' }: ProgressBarProps) {
  const percent = Math.round(clamp(value, 0, 1) * 100);
  const fill =
    tone === 'ok'
      ? 'bg-ok'
      : tone === 'warn'
        ? 'bg-warn'
        : tone === 'danger'
          ? 'bg-danger'
          : 'bg-accent';
  return (
    <div
      role="progressbar"
      aria-label={label}
      aria-valuenow={percent}
      aria-valuemin={0}
      aria-valuemax={100}
      className={cx('h-1.5 w-full overflow-hidden rounded-full bg-line', className)}
    >
      <div className={cx('h-full rounded-full transition-[width]', fill)} style={{ width: `${percent}%` }} />
    </div>
  );
}

export function Chip({
  children,
  tone = 'neutral',
  className,
}: {
  children: ReactNode;
  tone?: 'neutral' | 'accent' | 'ok' | 'warn' | 'danger';
  className?: string;
}) {
  return (
    <span
      className={cx(
        'inline-flex items-center gap-1 rounded-md px-1.5 py-0.5 text-2xs font-medium uppercase tracking-wide',
        tone === 'neutral' && 'bg-surface-hover text-muted',
        tone === 'accent' && 'bg-accent/15 text-accent',
        tone === 'ok' && 'bg-ok/15 text-ok',
        tone === 'warn' && 'bg-warn/15 text-warn',
        tone === 'danger' && 'bg-danger/15 text-danger',
        className,
      )}
    >
      {children}
    </span>
  );
}

export interface EmptyStateProps {
  icon?: ReactNode;
  title: string;
  body?: ReactNode;
  action?: ReactNode;
  className?: string;
}

export function EmptyState({ icon, title, body, action, className }: EmptyStateProps) {
  return (
    <div className={cx('flex flex-col items-center justify-center px-6 py-16 text-center', className)}>
      {icon && <div className="mb-4 text-subtle">{icon}</div>}
      <h3 className="text-base font-semibold text-text">{title}</h3>
      {body && <p className="mt-1.5 max-w-md text-sm text-muted">{body}</p>}
      {action && <div className="mt-5">{action}</div>}
    </div>
  );
}

/** Neutral placeholder while a list or grid loads. */
export function Skeleton({ className }: { className?: string }) {
  return <div className={cx('animate-pulse rounded-md bg-surface-hover', className)} />;
}

// ---------------------------------------------------------------------------
// Toggle
// ---------------------------------------------------------------------------

export interface ToggleProps {
  checked: boolean;
  onChange(checked: boolean): void;
  label: string;
  description?: string;
  disabled?: boolean;
}

export function Toggle({ checked, onChange, label, description, disabled }: ToggleProps) {
  const id = useId();
  return (
    <div className="flex items-start justify-between gap-6 py-3">
      <div className="min-w-0">
        <label htmlFor={id} className="block text-sm font-medium text-text">
          {label}
        </label>
        {description && <p className="mt-0.5 text-xs leading-relaxed text-muted">{description}</p>}
      </div>
      <button
        id={id}
        type="button"
        role="switch"
        aria-checked={checked}
        aria-label={label}
        disabled={disabled}
        onClick={() => onChange(!checked)}
        className={cx(
          'relative mt-0.5 h-6 w-11 shrink-0 rounded-full transition disabled:opacity-40',
          checked ? 'bg-accent' : 'bg-line-strong',
        )}
      >
        <span
          className={cx(
            'absolute top-0.5 h-5 w-5 rounded-full bg-white shadow transition-[left]',
            checked ? 'left-[22px]' : 'left-0.5',
          )}
        />
      </button>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Select
// ---------------------------------------------------------------------------

export interface SelectProps<T extends string> {
  value: T;
  options: { value: T; label: string }[];
  onChange(value: T): void;
  label: string;
  className?: string;
}

export function Select<T extends string>({
  value,
  options,
  onChange,
  label,
  className,
}: SelectProps<T>) {
  return (
    <select
      aria-label={label}
      value={value}
      onChange={(event) => onChange(event.target.value as T)}
      className={cx(
        'h-9 rounded-lg border border-line bg-surface px-2.5 text-sm text-text',
        'hover:bg-surface-hover focus-visible:border-accent',
        className,
      )}
    >
      {options.map((option) => (
        <option key={option.value} value={option.value}>
          {option.label}
        </option>
      ))}
    </select>
  );
}

// ---------------------------------------------------------------------------
// Menu
// ---------------------------------------------------------------------------

export interface MenuItem {
  label: string;
  icon?: ReactNode;
  onSelect(): void;
  destructive?: boolean;
  disabled?: boolean;
  /** Renders a divider above this item. */
  separated?: boolean;
}

/**
 * A dropdown menu anchored to its trigger.
 *
 * Deliberately not a full menu widget: it closes on Escape, on outside click and
 * on selection, and moves focus with the arrow keys. That is the whole contract
 * the track-row and album context menus need.
 */
export function Menu({
  trigger,
  items,
  align = 'end',
}: {
  trigger: (props: { open: boolean; toggle(): void; ref: React.Ref<HTMLButtonElement> }) => ReactNode;
  items: MenuItem[];
  align?: 'start' | 'end';
}) {
  const [open, setOpen] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const listRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onPointerDown = (event: PointerEvent) => {
      if (!containerRef.current?.contains(event.target as Node)) setOpen(false);
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        setOpen(false);
        triggerRef.current?.focus();
      }
    };
    document.addEventListener('pointerdown', onPointerDown);
    document.addEventListener('keydown', onKeyDown);
    // Focus the first item so the keyboard path works without a mouse.
    listRef.current?.querySelector<HTMLButtonElement>('button:not([disabled])')?.focus();
    return () => {
      document.removeEventListener('pointerdown', onPointerDown);
      document.removeEventListener('keydown', onKeyDown);
    };
  }, [open]);

  const move = (event: React.KeyboardEvent, direction: 1 | -1) => {
    event.preventDefault();
    const buttons = [...(listRef.current?.querySelectorAll<HTMLButtonElement>('button:not([disabled])') ?? [])];
    if (buttons.length === 0) return;
    const index = buttons.indexOf(document.activeElement as HTMLButtonElement);
    const next = (index + direction + buttons.length) % buttons.length;
    buttons[next]?.focus();
  };

  return (
    <div ref={containerRef} className="relative">
      {trigger({ open, toggle: () => setOpen((value) => !value), ref: triggerRef })}
      {open && (
        <div
          ref={listRef}
          role="menu"
          onKeyDown={(event) => {
            if (event.key === 'ArrowDown') move(event, 1);
            if (event.key === 'ArrowUp') move(event, -1);
          }}
          className={cx(
            'absolute z-50 mt-1 min-w-52 overflow-hidden rounded-xl border border-line',
            'bg-bg-elevated p-1 shadow-pop animate-slide-up',
            align === 'end' ? 'right-0' : 'left-0',
          )}
        >
          {items.map((item, index) => (
            <div key={`${item.label}-${index}`}>
              {item.separated && <div className="my-1 h-px bg-line" />}
              <button
                type="button"
                role="menuitem"
                disabled={item.disabled}
                onClick={() => {
                  setOpen(false);
                  item.onSelect();
                }}
                className={cx(
                  'flex w-full items-center gap-2.5 rounded-lg px-2.5 py-2 text-left text-sm transition',
                  'disabled:cursor-not-allowed disabled:opacity-40',
                  item.destructive
                    ? 'text-danger hover:bg-danger/10'
                    : 'text-text hover:bg-surface-hover',
                )}
              >
                {item.icon && <span className="shrink-0 text-muted">{item.icon}</span>}
                <span className="truncate">{item.label}</span>
              </button>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Section header
// ---------------------------------------------------------------------------

export function SectionHeader({
  title,
  subtitle,
  action,
  className,
}: {
  title: string;
  subtitle?: ReactNode;
  action?: ReactNode;
  className?: string;
}) {
  return (
    <div className={cx('flex items-end justify-between gap-4', className)}>
      <div className="min-w-0">
        <h2 className="text-lg font-semibold tracking-tight text-text">{title}</h2>
        {subtitle && <p className="mt-0.5 text-xs text-muted">{subtitle}</p>}
      </div>
      {action}
    </div>
  );
}
