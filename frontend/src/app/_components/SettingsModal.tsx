import { ModelConfig } from "@/components/ModelSettingsModal";
import { PreferenceSettings } from "@/components/PreferenceSettings";
import { DeviceSelection } from "@/components/DeviceSelection";
import { LanguageSelection } from "@/components/LanguageSelection";
import { TranscriptSettings } from "@/components/TranscriptSettings";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Switch } from "@/components/ui/switch";
import { toast } from "sonner";
import { useConfig } from "@/contexts/ConfigContext";
import { useRecordingState } from "@/contexts/RecordingStateContext";

type modalType =
  | "modelSettings"
  | "deviceSettings"
  | "languageSettings"
  | "modelSelector"
  | "errorAlert"
  | "chunkDropWarning";

/**
 * SettingsModals Component
 *
 * All settings modals consolidated into a single component.
 * Uses ConfigContext and RecordingStateContext internally - no prop drilling needed!
 */

interface SettingsModalsProps {
  modals: {
    modelSettings: boolean;
    deviceSettings: boolean;
    languageSettings: boolean;
    modelSelector: boolean;
    errorAlert: boolean;
    chunkDropWarning: boolean;
  };
  messages: {
    errorAlert: string;
    chunkDropWarning: string;
    modelSelector: string;
  };
  onClose: (name: modalType) => void;
}

const SELECT_CLASSES =
  "px-3 py-2 text-sm bg-background border border-input rounded-md shadow-sm focus:outline-none focus-visible:ring-1 focus-visible:ring-ring";

export function SettingsModals({
  modals,
  messages,
  onClose,
}: SettingsModalsProps) {
  // Contexts
  const {
    modelConfig,
    setModelConfig,
    models,
    modelOptions,
    error,
    selectedDevices,
    setSelectedDevices,
    selectedLanguage,
    setSelectedLanguage,
    transcriptModelConfig,
    setTranscriptModelConfig,
    showConfidenceIndicator,
    toggleConfidenceIndicator,
  } = useConfig();

  const { isRecording } = useRecordingState();

  return (
    <>
      {/* Legacy Settings Modal */}
      <Dialog
        open={modals.modelSettings}
        onOpenChange={(next) => !next && onClose("modelSettings")}
      >
        <DialogContent className="max-w-4xl max-h-[90vh] overflow-hidden flex flex-col p-0 gap-0">
          <DialogHeader className="p-6 border-b border-border">
            <DialogTitle>Preferences</DialogTitle>
          </DialogHeader>

          <div className="flex-1 overflow-y-auto p-6 space-y-8">
            {/* General Preferences Section */}
            <PreferenceSettings />

            {/* Divider */}
            <div className="border-t border-border pt-8">
              <h4 className="text-lg font-semibold text-foreground mb-4">
                AI Model Configuration
              </h4>
              <div className="space-y-4">
                <div>
                  <label className="block text-sm font-medium text-foreground mb-1">
                    Summarization Model
                  </label>
                  <div className="flex space-x-2">
                    <select
                      className={SELECT_CLASSES}
                      value={modelConfig.provider}
                      onChange={(e) => {
                        const provider = e.target
                          .value as ModelConfig["provider"];
                        setModelConfig({
                          ...modelConfig,
                          provider,
                          model: modelOptions[provider][0],
                        });
                      }}
                    >
                      <option value="builtin-ai">Built-in AI</option>
                      <option value="claude">Claude</option>
                      <option value="groq">Groq</option>
                      <option value="ollama">Ollama</option>
                      <option value="openrouter">OpenRouter</option>
                      <option value="openai">OpenAI</option>
                    </select>

                    <select
                      className={`flex-1 ${SELECT_CLASSES}`}
                      value={modelConfig.model}
                      onChange={(e) =>
                        setModelConfig((prev: ModelConfig) => ({
                          ...prev,
                          model: e.target.value,
                        }))
                      }
                    >
                      {modelOptions[modelConfig.provider].map(
                        (model: string) => (
                          <option key={model} value={model}>
                            {model}
                          </option>
                        ),
                      )}
                    </select>
                  </div>
                </div>
                {modelConfig.provider === "ollama" && (
                  <div>
                    <h4 className="text-lg font-bold mb-4">
                      Available Ollama Models
                    </h4>
                    {error && (
                      <Alert variant="destructive" className="mb-4">
                        <AlertDescription>{error}</AlertDescription>
                      </Alert>
                    )}
                    <div className="grid gap-4 max-h-[400px] overflow-y-auto pr-2">
                      {models.map((model) => (
                        <Card
                          key={model.id}
                          className={`p-4 cursor-pointer transition-colors ${
                            modelConfig.model === model.name
                              ? "ring-2 ring-ring bg-accent"
                              : "hover:bg-accent/50"
                          }`}
                          onClick={() =>
                            setModelConfig((prev: ModelConfig) => ({
                              ...prev,
                              model: model.name,
                            }))
                          }
                        >
                          <h3 className="font-bold">{model.name}</h3>
                          <p className="text-muted-foreground">
                            Size: {model.size}
                          </p>
                          <p className="text-muted-foreground">
                            Modified: {model.modified}
                          </p>
                        </Card>
                      ))}
                    </div>
                  </div>
                )}
              </div>
            </div>
          </div>

          <DialogFooter className="p-6 border-t border-border">
            <Button onClick={() => onClose("modelSettings")}>Done</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Device Settings Modal */}
      <Dialog
        open={modals.deviceSettings}
        onOpenChange={(next) => !next && onClose("deviceSettings")}
      >
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle>Audio Device Settings</DialogTitle>
          </DialogHeader>

          <DeviceSelection
            selectedDevices={selectedDevices}
            onDeviceChange={setSelectedDevices}
            disabled={isRecording}
          />

          <DialogFooter>
            <Button
              onClick={() => {
                const micDevice = selectedDevices.micDevice || "Default";
                const systemDevice = selectedDevices.systemDevice || "Default";
                toast.success("Devices selected", {
                  description: `Microphone: ${micDevice}, System Audio: ${systemDevice}`,
                });
                onClose("deviceSettings");
              }}
            >
              Done
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Language Settings Modal */}
      <Dialog
        open={modals.languageSettings}
        onOpenChange={(next) => !next && onClose("languageSettings")}
      >
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle>Language Settings</DialogTitle>
          </DialogHeader>

          <LanguageSelection
            selectedLanguage={selectedLanguage}
            onLanguageChange={setSelectedLanguage}
            disabled={isRecording}
            provider={transcriptModelConfig.provider}
          />

          <DialogFooter>
            <Button onClick={() => onClose("languageSettings")}>Done</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Model Selection Modal */}
      <Dialog
        open={modals.modelSelector}
        onOpenChange={(next) => !next && onClose("modelSelector")}
      >
        <DialogContent className="max-w-4xl max-h-[90vh] flex flex-col p-0 gap-0">
          <DialogHeader className="p-6 pb-4 border-b border-border">
            <DialogTitle>
              {messages.modelSelector
                ? "Speech Recognition Setup Required"
                : "Transcription Model Settings"}
            </DialogTitle>
          </DialogHeader>

          <div className="flex-1 overflow-y-auto p-6 pt-4">
            <TranscriptSettings
              transcriptModelConfig={transcriptModelConfig}
              setTranscriptModelConfig={setTranscriptModelConfig}
              onModelSelect={() => onClose("modelSelector")}
            />
          </div>

          <DialogFooter className="p-6 pt-4 border-t border-border sm:justify-between">
            {/* Confidence Indicator Toggle */}
            <div className="flex items-center gap-3">
              <Switch
                checked={showConfidenceIndicator}
                onCheckedChange={(checked) =>
                  toggleConfidenceIndicator(checked)
                }
              />
              <div>
                <p className="text-sm font-medium text-foreground">
                  Show Confidence Indicators
                </p>
                <p className="text-xs text-muted-foreground">
                  Display colored dots showing transcription confidence quality
                </p>
              </div>
            </div>

            <Button
              variant="secondary"
              onClick={() => onClose("modelSelector")}
            >
              {messages.modelSelector ? "Cancel" : "Done"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Error Alert Modal */}
      {modals.errorAlert && (
        <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50">
          <Alert
            variant="destructive"
            className="max-w-md mx-4 bg-background shadow-xl"
          >
            <AlertTitle>Recording Stopped</AlertTitle>
            <AlertDescription>
              {messages.errorAlert}
              <button
                onClick={() => onClose("errorAlert")}
                className="ml-2 text-destructive hover:text-destructive/80 underline"
              >
                Dismiss
              </button>
            </AlertDescription>
          </Alert>
        </div>
      )}

      {/* Chunk Drop Warning Modal */}
      {modals.chunkDropWarning && (
        <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50">
          <Alert className="max-w-lg mx-4 border-warning/50 text-warning bg-background shadow-xl">
            <AlertTitle>Transcription Performance Warning</AlertTitle>
            <AlertDescription className="text-warning">
              {messages.chunkDropWarning}
              <button
                onClick={() => onClose("chunkDropWarning")}
                className="ml-2 text-warning hover:text-warning/80 underline"
              >
                Dismiss
              </button>
            </AlertDescription>
          </Alert>
        </div>
      )}
    </>
  );
}
