import React, { useState, useEffect } from 'react';
import { getVersion } from '@tauri-apps/api/app';
import Image from 'next/image';
import AnalyticsConsentSwitch from './AnalyticsConsentSwitch';
import { UpdateDialog } from './UpdateDialog';
import { updateService, UpdateInfo, UPDATES_ENABLED } from '@/services/updateService';
import { Button } from './ui/button';
import { Loader2, CheckCircle2 } from 'lucide-react';
import { toast } from 'sonner';

export function About() {
  const [currentVersion, setCurrentVersion] = useState<string>('0.4.1');
  const [updateInfo, setUpdateInfo] = useState<UpdateInfo | null>(null);
  const [isChecking, setIsChecking] = useState(false);
  const [showUpdateDialog, setShowUpdateDialog] = useState(false);

  useEffect(() => {
    // Get current version on mount
    getVersion().then(setCurrentVersion).catch(console.error);
  }, []);

  const handleCheckForUpdates = async () => {
    setIsChecking(true);
    try {
      const info = await updateService.checkForUpdates(true);
      setUpdateInfo(info);
      if (info.available) {
        setShowUpdateDialog(true);
      } else {
        toast.success('You are running the latest version');
      }
    } catch (error: any) {
      console.error('Failed to check for updates:', error);
      toast.error('Failed to check for updates: ' + (error.message || 'Unknown error'));
    } finally {
      setIsChecking(false);
    }
  };

  return (
    <div className="p-4 space-y-4 h-[80vh] overflow-y-auto">
      {/* Compact Header */}
      <div className="text-center">
        <div className="mb-3">
          <Image src="icon_128x128.png" alt="Riff logo" width={64} height={64} className="mx-auto" />
        </div>
        <h1 className="text-xl font-bold text-foreground">Riff</h1>
        <span className="text-sm text-muted-foreground"> v{currentVersion}</span>
        <p className="text-medium text-muted-foreground mt-1">
          Record meetings. Get transcripts, summaries, journals and code — powered by whichever AI fits your workflow.
        </p>
        {UPDATES_ENABLED && (
          <div className="mt-3">
            <Button
              onClick={handleCheckForUpdates}
              disabled={isChecking}
              variant="outline"
              size="sm"
              className="text-xs"
            >
              {isChecking ? (
                <>
                  <Loader2 className="h-3 w-3 mr-2 animate-spin" />
                  Checking...
                </>
              ) : (
                <>
                  <CheckCircle2 className="h-3 w-3 mr-2" />
                  Check for Updates
                </>
              )}
            </Button>
            {updateInfo?.available && (
              <div className="mt-2 text-xs text-primary">Update available: v{updateInfo.version}</div>
            )}
          </div>
        )}
      </div>

      {/* Features Grid - Compact */}
      <div className="space-y-3">
        <h2 className="text-base font-semibold text-foreground">What makes Riff different</h2>
        <div className="grid grid-cols-2 gap-2">
          <div className="bg-muted rounded p-3 hover:bg-muted/80 transition-colors">
            <h3 className="font-bold text-sm text-foreground mb-1">Transcription & summaries</h3>
            <p className="text-xs text-muted-foreground leading-relaxed">
              Every word captured and timestamped. AI summaries hit your journals automatically when the meeting ends.
            </p>
          </div>
          <div className="bg-muted rounded p-3 hover:bg-muted/80 transition-colors">
            <h3 className="font-bold text-sm text-foreground mb-1">Use any model</h3>
            <p className="text-xs text-muted-foreground leading-relaxed">
              Local Ollama, Claude, Groq or OpenRouter. Run fully offline or use the best cloud model — your call.
            </p>
          </div>
          <div className="bg-muted rounded p-3 hover:bg-muted/80 transition-colors">
            <h3 className="font-bold text-sm text-foreground mb-1">Meeting to code</h3>
            <p className="text-xs text-muted-foreground leading-relaxed">
              Dev Sessions turn a transcript into requirements, a plan, a branch and a QA report.
            </p>
          </div>
          <div className="bg-muted rounded p-3 hover:bg-muted/80 transition-colors">
            <h3 className="font-bold text-sm text-foreground mb-1">Smart journals</h3>
            <p className="text-xs text-muted-foreground leading-relaxed">
              AI files each meeting into topic journals, so decisions and ideas are easy to find later.
            </p>
          </div>
        </div>
      </div>

      {/* Name - Compact */}
      <div className="bg-primary/10 rounded p-3 space-y-1">
        <h3 className="text-sm font-semibold text-foreground">Why &ldquo;Riff&rdquo;?</h3>
        <p className="text-s text-foreground leading-relaxed">
          The best meetings aren&rsquo;t presentations &mdash; they&rsquo;re riffs. People riff on an idea until it
          takes shape. Riff listens, captures every thread, then carries the idea the rest of the way: transcript,
          summary, journals, and if it&rsquo;s a dev idea, all the way to code.
        </p>
      </div>

      {/* Footer - Compact */}
      <div className="pt-2 border-t border-border text-center">
        <p className="text-xs text-muted-foreground">Built on Meetily by Zackriya Solutions (MIT)</p>
      </div>
      <AnalyticsConsentSwitch />

      {/* Update Dialog */}
      <UpdateDialog open={showUpdateDialog} onOpenChange={setShowUpdateDialog} updateInfo={updateInfo} />
    </div>
  );
}
