'use client';
import * as React from 'react';
import * as DialogPrimitive from '@radix-ui/react-dialog';
import { X } from 'lucide-react';
import { cn } from '@/lib/utils';

const Sheet = DialogPrimitive.Root;
const SheetTrigger = DialogPrimitive.Trigger;
const SheetClose = DialogPrimitive.Close;
const SheetPortal = DialogPrimitive.Portal;

const SheetOverlay = React.forwardRef<
  React.ElementRef<typeof DialogPrimitive.Overlay>,
  React.ComponentPropsWithoutRef<typeof DialogPrimitive.Overlay>
>(({ className, ...props }, ref) => (
  <DialogPrimitive.Overlay
    ref={ref}
    className={cn(
      'fixed inset-0 z-50 bg-black/60',
      'transition-opacity duration-300',
      'data-[state=closed]:opacity-0 data-[state=open]:opacity-100',
      className,
    )}
    {...props}
  />
));
SheetOverlay.displayName = 'SheetOverlay';

type SheetSide = 'left' | 'right';

const sideStyles: Record<SheetSide, string> = {
  left: cn(
    'fixed left-0 top-0 z-50 flex h-full w-72 flex-col shadow-2xl',
    'transition-transform duration-300 ease-in-out',
    'data-[state=closed]:-translate-x-full data-[state=open]:translate-x-0',
  ),
  right: cn(
    'fixed right-0 top-0 z-50 flex h-full w-full max-w-xl flex-col shadow-2xl bg-background',
    'transition-transform duration-300 ease-in-out',
    'data-[state=closed]:translate-x-full data-[state=open]:translate-x-0',
  ),
};

interface SheetContentProps extends React.ComponentPropsWithoutRef<typeof DialogPrimitive.Content> {
  side?: SheetSide;
}

const SheetContent = React.forwardRef<
  React.ElementRef<typeof DialogPrimitive.Content>,
  SheetContentProps
>(({ className, children, side = 'left', ...props }, ref) => (
  <SheetPortal>
    <SheetOverlay />
    <DialogPrimitive.Content
      ref={ref}
      className={cn(
        side === 'left' ? 'bg-slate-900' : '',
        sideStyles[side],
        className,
      )}
      {...props}
    >
      {children}
      <SheetClose className={cn(
        'absolute right-4 top-4 rounded-sm opacity-70 transition-opacity hover:opacity-100 focus:outline-none focus:ring-2',
        side === 'left'
          ? 'text-slate-400 hover:text-white focus:ring-slate-600'
          : 'text-muted-foreground hover:text-foreground focus:ring-ring',
      )}>
        <X className="h-5 w-5" />
        <span className="sr-only">Cerrar</span>
      </SheetClose>
    </DialogPrimitive.Content>
  </SheetPortal>
));
SheetContent.displayName = 'SheetContent';

export { Sheet, SheetClose, SheetContent, SheetPortal, SheetTrigger };
