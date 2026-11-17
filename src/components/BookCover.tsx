import { useState } from 'react';
import { BookOpen } from 'lucide-react';

interface BookCoverProps {
  src: string;
  title: string;
  author: string;
  className?: string;
}

export function BookCover({ src, title, author, className = '' }: BookCoverProps) {
  const [failed, setFailed] = useState(false);

  if (failed || !src) {
    return (
      <div
        className={`flex flex-col justify-between bg-slate-100 border border-slate-200 p-4 text-slate-800 select-none ${className}`}
        aria-label={`${title} cover`}
      >
        <div className="flex items-center justify-between text-slate-400">
          <BookOpen className="w-4 h-4" />
          <span className="font-mono text-[10px] tracking-wider">FOLIO</span>
        </div>
        <div>
          <p className="font-display text-sm font-semibold leading-snug line-clamp-3 text-slate-900">
            {title}
          </p>
          <p className="mt-1.5 text-xs text-slate-500 truncate">{author}</p>
        </div>
      </div>
    );
  }

  return (
    <img
      src={src}
      alt={`Cover of ${title} by ${author}`}
      referrerPolicy="no-referrer"
      onError={() => setFailed(true)}
      className={`object-cover bg-slate-100 border border-slate-200 ${className}`}
    />
  );
}
