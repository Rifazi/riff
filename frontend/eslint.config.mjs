import { dirname } from 'path';
import { fileURLToPath } from 'url';
import { FlatCompat } from '@eslint/eslintrc';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const compat = new FlatCompat({
  baseDirectory: __dirname,
});

// Pre-existing lint violations in legacy files that the UI-consolidation feature did
// not rewrite. Each rule below is relaxed for an explicit list of paths only — never by
// directory glob — so that any *new* violation, including one in a file this feature
// migrated, is still reported. These lists should only ever shrink: when a file is
// cleaned up, delete its entry rather than adding new ones.
const legacyExplicitAnyFiles = [
  'src/app/meeting-details/page-content.tsx',
  'src/app/meeting-details/page.tsx',
  'src/app/settings/page.tsx',
  'src/components/About.tsx',
  'src/components/AISummary/BlockNoteSummaryView.tsx',
  'src/components/BuiltInModelManager.tsx',
  'src/components/MeetingDetails/RetranscribeDialog.tsx',
  'src/components/ModelSettingsModal.tsx',
  'src/components/molecules/form-components/form-input-item.tsx',
  'src/components/molecules/form-components/form-input-switch.tsx',
  'src/components/molecules/form-components/form-select-item.tsx',
  'src/components/Sidebar/index.tsx',
  'src/components/Sidebar/SidebarProvider.tsx',
  'src/components/SummaryModelSettings.tsx',
  'src/components/TranscriptRecovery/TranscriptRecovery.tsx',
  'src/components/UpdateDialog.tsx',
  'src/contexts/OnboardingContext.tsx',
  'src/contexts/TranscriptContext.tsx',
  'src/hooks/meeting-details/useCopyOperations.ts',
  'src/hooks/meeting-details/useMeetingData.ts',
  'src/hooks/meeting-details/useMeetingOperations.ts',
  'src/hooks/meeting-details/useModelConfiguration.ts',
  'src/hooks/useAudioPlayer.ts',
  'src/hooks/useAutoScroll.ts',
  'src/hooks/useImportAudio.ts',
  'src/hooks/useRecordingStateSync.ts',
  'src/hooks/useRecordingStop.ts',
  'src/hooks/useTranscriptRecovery.ts',
  'src/lib/analytics.ts',
  'src/services/indexedDBService.ts',
  'src/services/storageService.ts',
  'src/types/index.ts',
];

// Legacy files carrying unused imports/locals (same policy as above).
const legacyUnusedVarsFiles = [
  'src/app/layout.tsx',
  'src/app/meeting-details/page-content.tsx',
  'src/app/page.tsx',
  'src/components/AISummary/BlockNoteSummaryView.tsx',
  'src/components/AISummary/index.tsx',
  'src/components/AISummary/Section.tsx',
  'src/components/AudioLevelMeter.tsx',
  'src/components/BuiltInModelManager.tsx',
  'src/components/ComplianceNotification.tsx',
  'src/components/DatabaseImport/HomebrewDatabaseDetector.tsx',
  'src/components/DeviceSelection.tsx',
  'src/components/DevSessions/AgentServerBanner.tsx',
  'src/components/EditableTitle.tsx',
  'src/components/ImportAudio/ImportAudioDialog.tsx',
  'src/components/LanguageSelection.tsx',
  'src/components/MeetingDetails/RetranscribeDialog.tsx',
  'src/components/MeetingDetails/TranscriptPanel.tsx',
  'src/components/ModelDownloadProgress.tsx',
  'src/components/ModelSettingsModal.tsx',
  'src/components/onboarding/OnboardingFlow.tsx',
  'src/components/onboarding/steps/DownloadProgressStep.tsx',
  'src/components/onboarding/steps/SetupOverviewStep.tsx',
  'src/components/ParakeetModelManager.tsx',
  'src/components/RecordingControls.tsx',
  'src/components/RecordingStatusBar.tsx',
  'src/components/SettingTabs.tsx',
  'src/components/shared/DownloadProgressToast.tsx',
  'src/components/Sidebar/index.tsx',
  'src/components/TranscriptView.tsx',
  'src/components/UpdateDialog.tsx',
  'src/components/VirtualizedTranscriptView.tsx',
  'src/components/WhisperModelManager.tsx',
  'src/contexts/TranscriptContext.tsx',
  'src/hooks/meeting-details/useCopyOperations.ts',
  'src/hooks/meeting-details/useMeetingData.ts',
  'src/hooks/meeting-details/useSummaryGeneration.ts',
  'src/hooks/usePaginatedTranscripts.ts',
  'src/hooks/useProcessingProgress.ts',
  'src/hooks/useRecordingStop.ts',
  'src/hooks/useTranscriptRecovery.ts',
];

// Legacy copy with raw quotes/apostrophes in JSX text (same policy as above).
const legacyUnescapedEntitiesFiles = [
  'src/app/dev-sessions/apps/api-spec/page.tsx',
  'src/app/dev-sessions/apps/integrations/page.tsx',
  'src/app/dev-sessions/page.tsx',
  'src/components/BluetoothPlaybackWarning.tsx',
  'src/components/ChunkProgressDisplay.tsx',
  'src/components/DevSessions/DevAgentSettings.tsx',
  'src/components/DevSessions/RequirementsButton.tsx',
  'src/components/DevSessions/stages/PlanStage.tsx',
  'src/components/DevSessions/stages/RequirementsStage.tsx',
  'src/components/DeviceSelection.tsx',
  'src/components/ImportAudio/ImportAudioDialog.tsx',
  'src/components/MeetingDetails/RetranscribeDialog.tsx',
  'src/components/ModelSettingsModal.tsx',
  'src/components/RecordingSettings.tsx',
  'src/components/onboarding/steps/PermissionsStep.tsx',
  'src/components/onboarding/steps/SetupOverviewStep.tsx',
  'src/lib/recordingNotification.tsx',
];

const eslintConfig = [
  ...compat.extends('next/core-web-vitals', 'next/typescript'),
  {
    files: legacyUnescapedEntitiesFiles,
    rules: {
      'react/no-unescaped-entities': 'off',
    },
  },
  {
    files: legacyExplicitAnyFiles,
    rules: {
      '@typescript-eslint/no-explicit-any': 'off',
    },
  },
  {
    files: legacyUnusedVarsFiles,
    rules: {
      '@typescript-eslint/no-unused-vars': 'off',
    },
  },
];

export default eslintConfig;
