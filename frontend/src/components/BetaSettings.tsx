'use client';

import { Switch } from './ui/switch';
import { Alert, AlertDescription, AlertTitle } from './ui/alert';
import { Badge } from './ui/badge';
import { Card, CardContent } from './ui/card';
import { FlaskConical, AlertCircle, Info } from 'lucide-react';
import { useConfig } from '@/contexts/ConfigContext';
import { BetaFeatureKey, BETA_FEATURE_NAMES, BETA_FEATURE_DESCRIPTIONS } from '@/types/betaFeatures';

export function BetaSettings() {
  const { betaFeatures, toggleBetaFeature } = useConfig();

  // Define feature order for display (allows custom ordering)
  const featureOrder: BetaFeatureKey[] = ['importAndRetranscribe'];

  return (
    <div className="space-y-6">
      {/* Heads-up banner */}
      <Alert variant="warning">
        <AlertCircle className="h-5 w-5" />
        <AlertTitle>Beta Features</AlertTitle>
        <AlertDescription className="mt-1">
          These features are still being tested. You may encounter issues, and we appreciate your feedback.
        </AlertDescription>
      </Alert>

      {/* Dynamic Feature Toggles - Automatically renders all features */}
      {featureOrder.map((featureKey) => (
        <Card key={featureKey}>
          <CardContent className="pt-6">
            <div className="flex items-center justify-between">
              <div className="flex-1">
                <div className="mb-2 flex items-center gap-2">
                  <FlaskConical className="h-5 w-5 text-muted-foreground" />
                  <h3 className="text-lg font-semibold text-foreground">{BETA_FEATURE_NAMES[featureKey]}</h3>
                  <Badge variant="warning">BETA</Badge>
                </div>
                <p className="text-sm text-muted-foreground">{BETA_FEATURE_DESCRIPTIONS[featureKey]}</p>
              </div>

              <div className="ml-6">
                <Switch
                  checked={betaFeatures[featureKey]}
                  onCheckedChange={(checked) => toggleBetaFeature(featureKey, checked)}
                />
              </div>
            </div>
          </CardContent>
        </Card>
      ))}

      {/* Info Box */}
      <Alert variant="info">
        <Info className="h-5 w-5" />
        <AlertDescription>
          <strong>Note:</strong> When disabled, beta features will be hidden. Your existing meetings remain unaffected.
        </AlertDescription>
      </Alert>
    </div>
  );
}
