"use client";

import React, { useState, useEffect } from "react";
import {
  Settings,
  ChevronLeftCircle,
  ChevronRightCircle,
  Home,
  Mic,
  Square,
  NotebookPen,
  Upload,
  Workflow,
  LibraryBig,
} from "lucide-react";
import { useRouter, usePathname } from "next/navigation";
import { useSidebar } from "./SidebarProvider";
import { ModelConfig } from "@/components/ModelSettingsModal";
import { TranscriptModelProps } from "@/components/TranscriptSettings";
import Analytics from "@/lib/analytics";
import { useQuery } from "@tanstack/react-query";
import { journalApi, journalKeys } from "@/lib/journal/api";
import { invoke } from "@tauri-apps/api/core";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { useRecordingState } from "@/contexts/RecordingStateContext";
import { useImportDialog } from "@/contexts/ImportDialogContext";
import { useConfig } from "@/contexts/ConfigContext";

import Logo from "../Logo";
import Info from "../Info";
import { TokenRingIndicator } from "../DevSessions/TokenRingIndicator";

const Sidebar: React.FC = () => {
  const router = useRouter();
  const pathname = usePathname();
  const isMeetingsPage =
    pathname?.startsWith("/meetings") ||
    pathname?.startsWith("/meeting-details");

  const { data: journalReview = [] } = useQuery({
    queryKey: journalKeys.review,
    queryFn: journalApi.listReview,
  });
  const reviewBadge = journalReview.length > 0 && (
    <Badge
      variant="warning"
      className="ml-auto rounded-full px-1.5"
      title="Parts of meetings need your input"
    >
      {journalReview.length}
    </Badge>
  );
  const { isCollapsed, toggleCollapse, handleRecordingToggle, serverAddress } =
    useSidebar();

  // Get recording state from RecordingStateContext (single source of truth)
  const { isRecording } = useRecordingState();
  const { openImportDialog } = useImportDialog();
  const { betaFeatures } = useConfig();
  const [showModelSettings, setShowModelSettings] = useState(false);
  const [modelConfig, setModelConfig] = useState<ModelConfig>({
    provider: "ollama",
    model: "",
    whisperModel: "",
    apiKey: null,
    ollamaEndpoint: null,
  });
  const [transcriptModelConfig, setTranscriptModelConfig] =
    useState<TranscriptModelProps>({
      provider: "parakeet",
      model: "parakeet-tdt-0.6b-v3-int8",
    });
  const [settingsSaveSuccess, setSettingsSaveSuccess] = useState<
    boolean | null
  >(null);

  useEffect(() => {
    // Note: Don't set hardcoded defaults - let DB be the source of truth
    const fetchModelConfig = async () => {
      // Only make API call if serverAddress is loaded
      if (!serverAddress) {
        console.log(
          "Waiting for server address to load before fetching model config",
        );
        return;
      }

      try {
        const data = (await invoke("api_get_model_config")) as any;
        if (data && data.provider !== null) {
          // Fetch API key if not included and provider requires it
          if (data.provider !== "ollama" && !data.apiKey) {
            try {
              const apiKeyData = (await invoke("api_get_api_key", {
                provider: data.provider,
              })) as string;
              data.apiKey = apiKeyData;
            } catch (err) {
              console.error("Failed to fetch API key:", err);
            }
          }
          setModelConfig(data);
        }
      } catch (error) {
        console.error("Failed to fetch model config:", error);
      }
    };

    fetchModelConfig();
  }, [serverAddress]);

  useEffect(() => {
    // Note: Don't set hardcoded defaults - let DB be the source of truth
    const fetchTranscriptSettings = async () => {
      // Only make API call if serverAddress is loaded
      if (!serverAddress) {
        console.log(
          "Waiting for server address to load before fetching transcript settings",
        );
        return;
      }

      try {
        const data = (await invoke("api_get_transcript_config")) as any;
        if (data && data.provider !== null) {
          setTranscriptModelConfig(data);
        }
      } catch (error) {
        console.error("Failed to fetch transcript settings:", error);
      }
    };
    fetchTranscriptSettings();
  }, [serverAddress]);

  // Listen for model config updates from other components
  useEffect(() => {
    const setupListener = async () => {
      const { listen } = await import("@tauri-apps/api/event");
      const unlisten = await listen<ModelConfig>(
        "model-config-updated",
        (event) => {
          console.log(
            "Sidebar received model-config-updated event:",
            event.payload,
          );
          setModelConfig(event.payload);
        },
      );

      return unlisten;
    };

    let cleanup: (() => void) | undefined;
    setupListener().then((fn) => (cleanup = fn));

    return () => {
      cleanup?.();
    };
  }, []);

  // Handle model config save
  const handleSaveModelConfig = async (config: ModelConfig) => {
    try {
      await invoke("api_save_model_config", {
        provider: config.provider,
        model: config.model,
        whisperModel: config.whisperModel,
        apiKey: config.apiKey,
        ollamaEndpoint: config.ollamaEndpoint,
      });

      setModelConfig(config);
      console.log("Model config saved successfully");
      setSettingsSaveSuccess(true);

      // Emit event to sync other components
      const { emit } = await import("@tauri-apps/api/event");
      await emit("model-config-updated", config);

      // Track settings change
      await Analytics.trackSettingsChanged(
        "model_config",
        `${config.provider}_${config.model}`,
      );
    } catch (error) {
      console.error("Error saving model config:", error);
      setSettingsSaveSuccess(false);
    }
  };

  const handleSaveTranscriptConfig = async (
    updatedConfig?: TranscriptModelProps,
  ) => {
    try {
      const configToSave = updatedConfig || transcriptModelConfig;
      const payload = {
        provider: configToSave.provider,
        model: configToSave.model,
        apiKey: configToSave.apiKey ?? null,
      };
      console.log("Saving transcript config with payload:", payload);

      await invoke("api_save_transcript_config", {
        provider: payload.provider,
        model: payload.model,
        apiKey: payload.apiKey,
      });

      setSettingsSaveSuccess(true);

      // Track settings change
      const transcriptConfigToSave = updatedConfig || transcriptModelConfig;
      await Analytics.trackSettingsChanged(
        "transcript_config",
        `${transcriptConfigToSave.provider}_${transcriptConfigToSave.model}`,
      );
    } catch (error) {
      console.error("Failed to save transcript config:", error);
      setSettingsSaveSuccess(false);
    }
  };

  // Expose setShowModelSettings to window for Rust tray to call
  useEffect(() => {
    (window as any).openSettings = () => {
      setShowModelSettings(true);
    };

    // Cleanup on unmount
    return () => {
      delete (window as any).openSettings;
    };
  }, []);

  const renderCollapsedIcons = () => {
    if (!isCollapsed) return null;

    const isHomePage = pathname === "/";
    const isSettingsPage = pathname === "/settings";
    const isDevSessionsPage = pathname?.startsWith("/dev-sessions");
    const isJournalPage = pathname?.startsWith("/journal");

    return (
      <TooltipProvider>
        <div className="flex flex-col h-full py-4 items-center justify-between">
          {/* Nav icons — top group */}
          <div className="flex flex-col items-center space-y-4">
          <Logo isCollapsed={isCollapsed} />

          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                variant="ghost"
                size="icon"
                onClick={() => router.push("/")}
                className={isHomePage ? "bg-muted" : ""}
              >
                <Home className="w-5 h-5 text-muted-foreground" />
              </Button>
            </TooltipTrigger>
            <TooltipContent side="right">
              <p>Home</p>
            </TooltipContent>
          </Tooltip>

          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                variant="destructive"
                size="icon"
                onClick={handleRecordingToggle}
                disabled={isRecording}
                className="rounded-full shadow-sm"
              >
                {isRecording ? (
                  <Square className="w-5 h-5" />
                ) : (
                  <Mic className="w-5 h-5" />
                )}
              </Button>
            </TooltipTrigger>
            <TooltipContent side="right">
              <p>
                {isRecording ? "Recording in progress..." : "Start Recording"}
              </p>
            </TooltipContent>
          </Tooltip>

          {betaFeatures.importAndRetranscribe && (
            <Tooltip>
              <TooltipTrigger asChild>
                <Button
                  variant="ghost"
                  size="icon"
                  onClick={() => openImportDialog()}
                  className="bg-primary/10 text-primary hover:bg-primary/20 hover:text-primary"
                >
                  <Upload className="w-5 h-5" />
                </Button>
              </TooltipTrigger>
              <TooltipContent side="right">
                <p>Import Audio</p>
              </TooltipContent>
            </Tooltip>
          )}

          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                variant="ghost"
                size="icon"
                onClick={() => router.push("/meetings")}
                className={isMeetingsPage ? "bg-muted" : ""}
              >
                <NotebookPen className="w-5 h-5 text-muted-foreground" />
              </Button>
            </TooltipTrigger>
            <TooltipContent side="right">
              <p>Meeting Notes</p>
            </TooltipContent>
          </Tooltip>

          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                variant="ghost"
                size="icon"
                onClick={() => router.push("/journal")}
                className={isJournalPage ? "bg-muted" : ""}
              >
                <span className="relative block">
                  <LibraryBig className="w-5 h-5 text-muted-foreground" />
                  {journalReview.length > 0 && (
                    <span className="absolute -right-1 -top-1 h-2 w-2 rounded-full bg-warning" />
                  )}
                </span>
              </Button>
            </TooltipTrigger>
            <TooltipContent side="right">
              <p>
                Journals
                {journalReview.length > 0
                  ? ` · ${journalReview.length} need your input`
                  : ""}
              </p>
            </TooltipContent>
          </Tooltip>

          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                variant="ghost"
                size="icon"
                onClick={() => router.push("/dev-sessions")}
                className={isDevSessionsPage ? "bg-muted" : ""}
              >
                <Workflow className="w-5 h-5 text-muted-foreground" />
              </Button>
            </TooltipTrigger>
            <TooltipContent side="right">
              <p>Dev Sessions</p>
            </TooltipContent>
          </Tooltip>

          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                variant="ghost"
                size="icon"
                onClick={() => router.push("/settings")}
                className={isSettingsPage ? "bg-muted" : ""}
              >
                <Settings className="w-5 h-5 text-muted-foreground" />
              </Button>
            </TooltipTrigger>
            <TooltipContent side="right">
              <p>Settings</p>
            </TooltipContent>
          </Tooltip>

          </div>{/* end nav group */}

          {/* Bottom group — pinned to the bottom */}
          <div className="flex flex-col items-center space-y-2 pb-1">
            <TokenRingIndicator />
            <Info isCollapsed={isCollapsed} />
          </div>
        </div>
      </TooltipProvider>
    );
  };

  return (
    <div className="fixed top-0 left-0 h-screen z-40">
      {/* Floating collapse button */}
      <Button
        variant="outline"
        size="icon"
        onClick={toggleCollapse}
        className="absolute -right-6 top-20 z-50 h-8 w-8 rounded-full bg-card shadow-lg"
        style={{ transform: "translateX(50%)" }}
      >
        {isCollapsed ? (
          <ChevronRightCircle className="w-6 h-6" />
        ) : (
          <ChevronLeftCircle className="w-6 h-6" />
        )}
      </Button>

      <div
        className={`h-screen bg-card border-r border-border shadow-sm flex flex-col transition-all duration-300 ${
          isCollapsed ? "w-16" : "w-64"
        }`}
      >
        {/*  Header with traffic light spacing */}
        <div className="flex-shrink-0 h-22 flex items-center">
          {/* Title container */}

          <div className="flex-1">
            {!isCollapsed && (
              <div className="p-3">
                <Logo isCollapsed={isCollapsed} />
              </div>
            )}
          </div>
        </div>

        {/* Main content - scrollable area */}
        <div className="flex-1 flex flex-col min-h-0">
          {/* Fixed navigation items */}
          <div className="flex-shrink-0">
            {!isCollapsed && (
              <div
                onClick={() => router.push("/")}
                className="p-3 text-lg font-semibold items-center hover:bg-muted h-10 flex mx-3 mt-3 rounded-lg cursor-pointer text-foreground"
              >
                <Home className="w-4 h-4 mr-2" />
                <span>Home</span>
              </div>
            )}
            {!isCollapsed && (
              <div
                onClick={() => router.push("/meetings")}
                className={`p-3 text-lg font-semibold items-center h-10 flex mx-3 mt-1 rounded-lg cursor-pointer text-foreground ${isMeetingsPage ? "bg-muted" : "hover:bg-muted"}`}
              >
                <NotebookPen className="w-4 h-4 mr-2" />
                <span>Meeting Notes</span>
              </div>
            )}
            {!isCollapsed && (
              <div
                onClick={() => router.push("/journal")}
                className={`p-3 text-lg font-semibold items-center h-10 flex mx-3 mt-1 rounded-lg cursor-pointer text-foreground ${pathname?.startsWith("/journal") ? "bg-muted" : "hover:bg-muted"}`}
              >
                <LibraryBig className="w-4 h-4 mr-2" />
                <span>Journals</span>
                {reviewBadge}
              </div>
            )}
            {!isCollapsed && (
              <div
                onClick={() => router.push("/dev-sessions")}
                className={`p-3 text-lg font-semibold items-center h-10 flex mx-3 mt-1 rounded-lg cursor-pointer text-foreground ${pathname?.startsWith("/dev-sessions") ? "bg-muted" : "hover:bg-muted"}`}
              >
                <Workflow className="w-4 h-4 mr-2" />
                <span>Dev Sessions</span>
              </div>
            )}
          </div>

          {/* Content area */}
          <div className="flex-1 flex flex-col min-h-0">
            {renderCollapsedIcons()}
          </div>
        </div>

        {/* Footer */}
        {!isCollapsed && (
          <div className="flex-shrink-0 p-2 border-t border-border">
            <Button
              variant="destructive"
              onClick={handleRecordingToggle}
              disabled={isRecording}
              className="w-full shadow-sm"
            >
              {isRecording ? (
                <>
                  <Square className="w-4 h-4 mr-2" />
                  <span>Recording in progress...</span>
                </>
              ) : (
                <>
                  <Mic className="w-4 h-4 mr-2" />
                  <span>Start Recording</span>
                </>
              )}
            </Button>

            {betaFeatures.importAndRetranscribe && (
              <Button
                variant="ghost"
                onClick={() => openImportDialog()}
                className="w-full mt-1 bg-primary/10 text-primary hover:bg-primary/20 hover:text-primary shadow-sm"
              >
                <Upload className="w-4 h-4 mr-2" />
                <span>Import Audio</span>
              </Button>
            )}

            <Button
              variant="secondary"
              onClick={() => router.push("/settings")}
              className="w-full mt-1 mb-1 shadow-sm"
            >
              <Settings className="w-4 h-4 mr-2" />
              <span>Settings</span>
            </Button>
            <Info isCollapsed={isCollapsed} />
            <div className="w-full flex items-center justify-center px-3 py-1 text-xs text-muted-foreground">
              v0.4.1
            </div>
            <TokenRingIndicator showLabel />
          </div>
        )}
      </div>
    </div>
  );
};

export default Sidebar;
