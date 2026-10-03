'use client';

import React from 'react';
import { Info, Shield } from 'lucide-react';

import { AnalyticsDataCategory } from './AnalyticsDataCategory';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';

interface AnalyticsDataModalProps {
  isOpen: boolean;
  onClose: () => void;
  onConfirmDisable: () => void;
}

/** The categories collected when analytics is enabled, in display order. */
const DATA_CATEGORIES = [
  {
    title: 'Model Preferences',
    items: [
      'Transcription model (e.g., "Whisper large-v3", "Parakeet")',
      'Summary model (e.g., "Llama 3.2", "Claude Sonnet")',
      'Model provider (e.g., "Local", "Ollama", "OpenRouter")',
    ],
    note: 'Helps us understand which models users prefer',
  },
  {
    title: 'Anonymous Meeting Metrics',
    items: [
      'Recording duration (e.g., "125 seconds")',
      'Pause duration (e.g., "5 seconds")',
      'Number of transcript segments',
      'Number of audio chunks processed',
    ],
    note: 'Helps us optimize performance and understand usage patterns',
  },
  {
    title: 'Device Types (Not Names)',
    items: [
      'Microphone type: "Bluetooth" or "Wired" or "Unknown"',
      'System audio type: "Bluetooth" or "Wired" or "Unknown"',
    ],
    note: 'Helps us improve compatibility, NOT the actual device names',
  },
  {
    title: 'App Usage Patterns',
    items: [
      'App started/stopped events',
      'Session duration',
      'Feature usage (e.g., "settings changed")',
      'Error occurrences (helps us fix bugs)',
    ],
    note: 'Helps us improve user experience',
  },
  {
    title: 'Platform Information',
    items: [
      'Operating system (e.g., "macOS", "Windows")',
      'App version (automatically included in all events)',
      'Architecture (e.g., "x86_64", "aarch64")',
    ],
    note: 'Helps us prioritize platform support',
  },
];

const NOT_COLLECTED = [
  'Meeting names or titles',
  'File names, file paths, or meeting folders',
  'Meeting transcripts or content',
  'Audio recordings',
  'Device names (only types: Bluetooth/Wired)',
  'Personal information',
  'Any identifiable data',
];

const EXAMPLE_EVENT = `{
  "event": "meeting_ended",
  "app_version": "0.4.1",
  "transcription_provider": "parakeet",
  "transcription_model": "parakeet-tdt-0.6b-v3-int8",
  "summary_provider": "ollama",
  "summary_model": "llama3.2:latest",
  "total_duration_seconds": "125.5",
  "microphone_device_type": "Wired",
  "system_audio_device_type": "Bluetooth",
  "chunks_processed": "150",
  "had_fatal_error": "false"
}`;

export default function AnalyticsDataModal({ isOpen, onClose, onConfirmDisable }: AnalyticsDataModalProps) {
  return (
    <Dialog open={isOpen} onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="max-h-[90vh] max-w-2xl overflow-y-auto">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-3 text-xl">
            <Shield className="h-6 w-6 text-primary" />
            What Analytics Collects
          </DialogTitle>
        </DialogHeader>

        <div className="space-y-6">
          {/* Privacy Notice */}
          <Alert variant="success">
            <Info className="h-5 w-5" />
            <AlertDescription>
              <p className="mb-1 font-semibold">Your Privacy is Protected</p>
              <p>
                Analytics is off by default. If you enable it, we collect <strong>anonymous usage data only</strong>. No
                meeting content, names, file paths, or personal information is ever collected.
              </p>
            </AlertDescription>
          </Alert>

          {/* Data Categories */}
          <div className="space-y-4">
            <h3 className="text-lg font-semibold text-foreground">Data We Collect When Enabled:</h3>

            {DATA_CATEGORIES.map((category, index) => (
              <AnalyticsDataCategory
                key={category.title}
                index={index + 1}
                title={category.title}
                items={category.items}
                note={category.note}
              />
            ))}
          </div>

          {/* What We DON'T Collect */}
          <Alert variant="destructive">
            <AlertDescription>
              <h4 className="mb-2 font-semibold">What We DON&apos;T Collect:</h4>
              <ul className="ml-4 space-y-1 text-sm">
                {NOT_COLLECTED.map((item) => (
                  <li key={item}>• ❌ {item}</li>
                ))}
              </ul>
            </AlertDescription>
          </Alert>

          {/* Example Event */}
          <div className="rounded-lg border border-border bg-muted p-4">
            <h4 className="mb-2 font-semibold text-foreground">Example Event:</h4>
            <pre className="overflow-x-auto text-xs text-foreground">{EXAMPLE_EVENT}</pre>
          </div>
        </div>

        <DialogFooter className="justify-between gap-4 sm:justify-between">
          <Button variant="outline" onClick={onClose}>
            Keep Analytics Enabled
          </Button>
          <Button variant="destructive" onClick={onConfirmDisable}>
            Confirm: Disable Analytics
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
