import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { useAuth } from '@/auth/AuthContext';
import { Ionicons } from '@expo/vector-icons';
import { useFocusEffect } from '@react-navigation/native';
import { Item } from '@/components/Item';
import { ItemGroup } from '@/components/ItemGroup';
import { ItemList } from '@/components/ItemList';
import { Modal } from '@/modal';
import { t, brandText } from '@/text';
import { useSettingMutable, useProfile, useServerFeature } from '@/sync/storage';
import { sync } from '@/sync/sync';
import { useUnistyles } from 'react-native-unistyles';
import { Switch } from '@/components/Switch';
import { getDisplayName } from '@/sync/profile';
import { Image } from 'expo-image';
import { useHappyAction } from '@/hooks/useHappyAction';
import { disconnectGitHub } from '@/sync/apiGithub';
import { disconnectService } from '@/sync/apiServices';
import { fetchPushTokens, type PushToken } from '@/sync/apiPush';
import { tracking } from '@/track';
import {
    getCurrentExpoPushToken,
    getCurrentPushDeviceMetadata,
    getPushPermissionInfo,
    requestPushPermissionOrOpenSettings,
    removePushToken,
    syncCurrentPushToken,
    type PushPermissionInfo,
} from '@/sync/pushRegistration';

function formatPushPermissionLabel(permission: PushPermissionInfo | null): string {
    if (!permission) {
        return 'Loading';
    }
    if (permission.status === 'unsupported') {
        return 'Unavailable';
    }
    if (permission.granted) {
        return 'Allowed';
    }
    if (permission.status === 'denied') {
        return 'Denied';
    }
    return 'Not requested';
}

function formatPushPermissionSubtitle(permission: PushPermissionInfo | null): string {
    if (!permission) {
        return 'Checking push notification permissions for this device.';
    }
    if (permission.status === 'unsupported') {
        return 'Push notification permissions are only managed on mobile devices.';
    }
    if (permission.granted) {
        return 'This device can receive push notifications.';
    }
    if (permission.canAskAgain) {
        return 'The system prompt can still be shown again from the app.';
    }
    return 'iOS has stopped prompting. Open system settings to enable notifications again.';
}

function formatPushTokenFingerprint(token: string): string {
    const rawValue = token.replace(/^ExponentPushToken\[/, '').replace(/\]$/, '');
    if (rawValue.length <= 12) {
        return rawValue;
    }
    return `${rawValue.slice(0, 6)}…${rawValue.slice(-6)}`;
}

function formatPushTimestamp(timestamp: number): string {
    return new Date(timestamp).toLocaleString();
}

function buildPushTokenSubtitle(pushToken: PushToken, options: {
    isCurrentDevice: boolean;
    currentDeviceLabel: string;
    currentAppLabel: string | null;
}): string {
    const lines: string[] = [];

    if (options.isCurrentDevice) {
        lines.push(options.currentDeviceLabel);
        if (options.currentAppLabel) {
            lines.push(options.currentAppLabel);
        }
    } else {
        lines.push('Other device or stale registration');
    }

    lines.push(`Registered: ${formatPushTimestamp(pushToken.createdAt)}`);
    lines.push(`Last seen: ${formatPushTimestamp(pushToken.updatedAt)}`);
    lines.push(`Server ID: ${pushToken.id}`);
    lines.push(`Token: ${formatPushTokenFingerprint(pushToken.token)}`);
    return lines.join('\n');
}

export default React.memo(() => {
    const { theme } = useUnistyles();
    const auth = useAuth();
    const [analyticsOptOut, setAnalyticsOptOut] = useSettingMutable('analyticsOptOut');
    const profile = useProfile();
    const githubConnectEnabled = useServerFeature('githubConnect');
    const pushEnabled = useServerFeature('push');
    const currentPushDevice = useMemo(() => getCurrentPushDeviceMetadata(), []);
    const [pushTokens, setPushTokens] = useState<PushToken[]>([]);
    const [pushPermission, setPushPermission] = useState<PushPermissionInfo | null>(null);
    const [currentPushToken, setCurrentPushToken] = useState<string | null>(null);
    const [loadingPushSettings, setLoadingPushSettings] = useState(false);
    const [requestingPushPermission, setRequestingPushPermission] = useState(false);
    const [refreshingPushToken, setRefreshingPushToken] = useState(false);
    const [deletingPushToken, setDeletingPushToken] = useState<string | null>(null);

    // Profile display values
    const displayName = getDisplayName(profile);
    const githubUsername = profile.github?.login;

    const loadPushSettings = useCallback(async (showError = false) => {
        if (!auth.credentials || !pushEnabled) {
            setPushTokens([]);
            setPushPermission(null);
            setCurrentPushToken(null);
            return;
        }

        setLoadingPushSettings(true);
        try {
            const [tokens, permission, liveToken] = await Promise.all([
                fetchPushTokens(auth.credentials),
                getPushPermissionInfo(),
                getCurrentExpoPushToken(),
            ]);
            setPushTokens(tokens);
            setPushPermission(permission);
            setCurrentPushToken(liveToken);
        } catch (error) {
            console.error('Failed to load push notification settings:', error);
            if (showError) {
                Modal.alert(t('common.error'), 'Failed to load push notification settings.');
            }
        } finally {
            setLoadingPushSettings(false);
        }
    }, [auth.credentials, pushEnabled]);

    useEffect(() => {
        void loadPushSettings();
    }, [loadPushSettings]);

    useFocusEffect(
        useCallback(() => {
            void loadPushSettings();
        }, [loadPushSettings])
    );

    // GitHub disconnection
    const [disconnecting, handleDisconnectGitHub] = useHappyAction(async () => {
        const confirmed = await Modal.confirm(
            t('modals.disconnectGithub'),
            t('modals.disconnectGithubConfirm'),
            { confirmText: t('modals.disconnect'), destructive: true }
        );
        if (confirmed) {
            await disconnectGitHub(auth.credentials!);
        }
    });

    // Service disconnection
    const [disconnectingService, setDisconnectingService] = useState<string | null>(null);
    const handleDisconnectService = async (service: string, displayName: string) => {
        const confirmed = await Modal.confirm(
            t('modals.disconnectService', { service: displayName }),
            t('modals.disconnectServiceConfirm', { service: displayName }),
            { confirmText: t('modals.disconnect'), destructive: true }
        );
        if (confirmed) {
            setDisconnectingService(service);
            try {
                await disconnectService(auth.credentials!, service);
                await sync.refreshProfile();
                // The profile will be updated via sync
            } catch (error) {
                Modal.alert(t('common.error'), t('errors.disconnectServiceFailed', { service: displayName }));
            } finally {
                setDisconnectingService(null);
            }
        }
    };

    const handleLogout = async () => {
        const confirmed = await Modal.confirm(
            t('common.logout'),
            t('settingsAccount.logoutConfirm'),
            { confirmText: t('common.logout'), destructive: true }
        );
        if (confirmed) {
            auth.logout();
        }
    };

    const handlePushPermissionRequest = useCallback(async () => {
        if (!auth.credentials) {
            return;
        }

        setRequestingPushPermission(true);
        try {
            const result = await requestPushPermissionOrOpenSettings();
            setPushPermission(result.permission);

            if (result.granted) {
                await syncCurrentPushToken(auth.credentials);
                await loadPushSettings();
                Modal.alert(t('common.success'), 'Push notifications are enabled for this device.');
                return;
            }

            await loadPushSettings();

            if (result.openedSettings) {
                Modal.alert('Open Settings', brandText('The system will not show the permission prompt again, so Happy opened Settings instead.'));
                return;
            }

            Modal.alert(t('common.error'), 'Push notification permission was not granted.');
        } catch (error) {
            console.error('Failed to request push permission:', error);
            Modal.alert(t('common.error'), 'Failed to request push notification permission.');
        } finally {
            setRequestingPushPermission(false);
        }
    }, [auth.credentials, loadPushSettings]);

    const handleRefreshCurrentPushToken = useCallback(async () => {
        if (!auth.credentials) {
            return;
        }

        setRefreshingPushToken(true);
        try {
            const result = await syncCurrentPushToken(auth.credentials);
            setPushPermission(result.permission);
            await loadPushSettings();

            if (!result.permission.granted) {
                Modal.alert(t('common.error'), 'Push notifications are not enabled for this device yet.');
                return;
            }

            Modal.alert(t('common.success'), 'This device push token was refreshed.');
        } catch (error) {
            console.error('Failed to refresh push token:', error);
            Modal.alert(t('common.error'), 'Failed to refresh this device push token.');
        } finally {
            setRefreshingPushToken(false);
        }
    }, [auth.credentials, loadPushSettings]);

    const handleDeletePushToken = useCallback(async (pushToken: PushToken) => {
        if (!auth.credentials) {
            return;
        }

        const confirmed = await Modal.confirm(
            'Delete Push Token',
            `Remove ${formatPushTokenFingerprint(pushToken.token)} from your account?`,
            { confirmText: t('common.delete'), destructive: true }
        );

        if (!confirmed) {
            return;
        }

        setDeletingPushToken(pushToken.token);
        try {
            await removePushToken(auth.credentials, pushToken.token);
            await loadPushSettings();
        } catch (error) {
            console.error('Failed to delete push token:', error);
            Modal.alert(t('common.error'), 'Failed to delete push token.');
        } finally {
            setDeletingPushToken(null);
        }
    }, [auth.credentials, loadPushSettings]);

    return (
        <>
            <ItemList>
                {/* Account Info */}
                <ItemGroup title={t('settingsAccount.accountInformation')}>
                    <Item
                        title={t('settingsAccount.status')}
                        detail={auth.isAuthenticated ? t('settingsAccount.statusActive') : t('settingsAccount.statusNotAuthenticated')}
                        showChevron={false}
                    />
                    <Item
                        title={t('settingsAccount.anonymousId')}
                        detail={sync.anonID || t('settingsAccount.notAvailable')}
                        showChevron={false}
                        copy={!!sync.anonID}
                    />
                    <Item
                        title={t('settingsAccount.publicId')}
                        detail={sync.serverID || t('settingsAccount.notAvailable')}
                        showChevron={false}
                        copy={!!sync.serverID}
                    />
                </ItemGroup>

                {/* Profile Section */}
                {(displayName || githubUsername || profile.avatar) && (
                    <ItemGroup title={t('settingsAccount.profile')}>
                        {displayName && (
                            <Item
                                title={t('settingsAccount.name')}
                                detail={displayName}
                                showChevron={false}
                            />
                        )}
                        {githubUsername && (
                            <Item
                                title={t('settingsAccount.github')}
                                detail={`@${githubUsername}`}
                                subtitle={githubConnectEnabled ? t('settingsAccount.tapToDisconnect') : undefined}
                                onPress={githubConnectEnabled ? handleDisconnectGitHub : undefined}
                                loading={disconnecting}
                                showChevron={false}
                                icon={profile.avatar?.url ? (
                                    <Image
                                        source={{ uri: profile.avatar.url }}
                                        style={{ width: 29, height: 29, borderRadius: 14.5 }}
                                        placeholder={{ thumbhash: profile.avatar.thumbhash }}
                                        contentFit="cover"
                                        transition={200}
                                        cachePolicy="memory-disk"
                                    />
                                ) : (
                                    <Ionicons name="logo-github" size={29} color={theme.colors.textSecondary} />
                                )}
                            />
                        )}
                    </ItemGroup>
                )}

                {/* Connected Services Section */}
                {profile.connectedServices && profile.connectedServices.length > 0 && (() => {
                    // Map of service IDs to display names and icons
                    const knownServices = {
                        anthropic: { name: 'Claude Code', icon: require('@/assets/images/icon-claude.png'), tintColor: null },
                        gemini: { name: 'Google Gemini', icon: require('@/assets/images/icon-gemini.png'), tintColor: null },
                        openai: { name: 'OpenAI Codex', icon: require('@/assets/images/icon-gpt.png'), tintColor: theme.colors.text }
                    };
                    
                    // Filter to only known services
                    const displayServices = profile.connectedServices.filter(
                        service => service in knownServices
                    );
                    
                    if (displayServices.length === 0) return null;
                    
                    return (
                        <ItemGroup title={t('settings.connectedAccounts')}>
                            {displayServices.map(service => {
                                const serviceInfo = knownServices[service as keyof typeof knownServices];
                                const isDisconnecting = disconnectingService === service;
                                return (
                                    <Item
                                        key={service}
                                        title={serviceInfo.name}
                                        detail={t('settingsAccount.statusActive')}
                                        subtitle={t('settingsAccount.tapToDisconnect')}
                                        onPress={() => handleDisconnectService(service, serviceInfo.name)}
                                        loading={isDisconnecting}
                                        disabled={isDisconnecting}
                                        showChevron={false}
                                        icon={
                                            <Image
                                                source={serviceInfo.icon}
                                                style={{ width: 29, height: 29 }}
                                                tintColor={serviceInfo.tintColor}
                                                contentFit="contain"
                                            />
                                        }
                                    />
                                );
                            })}
                        </ItemGroup>
                    );
                })()}

                {/* Analytics Section */}
                {tracking && (
                    <ItemGroup
                        title={t('settingsAccount.privacy')}
                        footer={t('settingsAccount.privacyDescription')}
                    >
                        <Item
                            title={t('settingsAccount.analytics')}
                            subtitle={analyticsOptOut ? t('settingsAccount.analyticsDisabled') : t('settingsAccount.analyticsEnabled')}
                            rightElement={
                                <Switch
                                    value={!analyticsOptOut}
                                    onValueChange={(value) => {
                                        const optOut = !value;
                                        setAnalyticsOptOut(optOut);
                                    }}
                                    trackColor={{ false: '#767577', true: '#34C759' }}
                                    thumbColor="#FFFFFF"
                                />
                            }
                            showChevron={false}
                        />
                    </ItemGroup>
                )}

                {pushEnabled && (<>
                <ItemGroup
                    title="Push Notifications"
                    footer="Shows every push token registered on your account. Tap an old token to delete it."
                >
                    <Item
                        title="Permission"
                        detail={formatPushPermissionLabel(pushPermission)}
                        subtitle={formatPushPermissionSubtitle(pushPermission)}
                        icon={<Ionicons name="notifications-outline" size={29} color="#007AFF" />}
                        loading={loadingPushSettings}
                        showChevron={false}
                    />
                    <Item
                        title="Request Permission Again"
                        subtitle={pushPermission?.status === 'unsupported'
                            ? 'Push notification permissions are only available on iPhone and Android.'
                            : pushPermission?.canAskAgain
                            ? 'Shows the system prompt again if iOS still allows it.'
                            : 'Opens system settings when iOS will not prompt again.'}
                        icon={<Ionicons name="shield-checkmark-outline" size={29} color="#34C759" />}
                        onPress={handlePushPermissionRequest}
                        loading={requestingPushPermission}
                        disabled={requestingPushPermission || loadingPushSettings || pushPermission?.status === 'unsupported' || !auth.credentials}
                        showChevron={false}
                    />
                    <Item
                        title="Re-register This Device"
                        subtitle={currentPushToken
                            ? `Current token ${formatPushTokenFingerprint(currentPushToken)}`
                            : 'Fetches the current Expo token and registers it again.'}
                        icon={<Ionicons name="refresh-outline" size={29} color="#FF9500" />}
                        onPress={handleRefreshCurrentPushToken}
                        loading={refreshingPushToken}
                        disabled={refreshingPushToken || loadingPushSettings || !auth.credentials}
                        showChevron={false}
                    />
                </ItemGroup>

                <ItemGroup
                    title={`Registered Tokens (${pushTokens.length})`}
                    footer="Current-device metadata comes from this phone. Older tokens use their token fingerprint plus server timestamps."
                >
                    {pushTokens.length === 0 ? (
                        <Item
                            title="No registered push tokens"
                            subtitle="Once this device is registered, it will appear here."
                            showChevron={false}
                        />
                    ) : (
                        <>
                            {pushTokens.map((pushToken) => {
                                const isCurrentDevice = currentPushToken === pushToken.token;
                                return (
                                    <Item
                                        key={pushToken.id}
                                        title={formatPushTokenFingerprint(pushToken.token)}
                                        detail={isCurrentDevice ? 'This device' : undefined}
                                        subtitle={buildPushTokenSubtitle(pushToken, {
                                            isCurrentDevice,
                                            currentDeviceLabel: currentPushDevice.deviceLabel,
                                            currentAppLabel: currentPushDevice.appLabel,
                                        })}
                                        subtitleLines={0}
                                        icon={(
                                            <Ionicons
                                                name={isCurrentDevice ? 'phone-portrait-outline' : 'trash-outline'}
                                                size={29}
                                                color={isCurrentDevice ? theme.colors.textSecondary : '#FF3B30'}
                                            />
                                        )}
                                        onPress={isCurrentDevice ? undefined : () => handleDeletePushToken(pushToken)}
                                        loading={deletingPushToken === pushToken.token}
                                        disabled={deletingPushToken !== null}
                                        showChevron={false}
                                        copy={isCurrentDevice ? pushToken.token : false}
                                    />
                                );
                            })}
                        </>
                    )}
                </ItemGroup>
                </>)}

                {/* Danger Zone */}
                <ItemGroup title={t('settingsAccount.dangerZone')}>
                    <Item
                        title={t('settingsAccount.logout')}
                        subtitle={t('settingsAccount.logoutSubtitle')}
                        icon={<Ionicons name="log-out-outline" size={29} color="#FF3B30" />}
                        destructive
                        onPress={handleLogout}
                    />
                </ItemGroup>
            </ItemList>
        </>
    );
});
