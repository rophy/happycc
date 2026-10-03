import React from 'react';
import { View, Text, Platform, Pressable, ScrollView } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { Typography } from '@/constants/Typography';
import { RoundButton } from '@/components/RoundButton';
import { t, brandText } from '@/text';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';
import { useAllMachines } from '@/sync/storage';
import { collectMachineChoices } from '@/sync/machineChoices';
import { useRouter } from 'expo-router';
import { getServerUrl } from '@/sync/serverConfig';

const stylesheet = StyleSheet.create((theme) => ({
    container: {
        flex: 1,
        alignItems: 'center',
        justifyContent: 'center',
        marginBottom: 32,
    },
    title: {
        marginBottom: 16,
        textAlign: 'center',
        fontSize: 24,
        color: theme.colors.text,
        ...Typography.default('semiBold'),
    },
    stateIcon: {
        marginBottom: 20,
    },
    stateTitle: {
        marginBottom: 8,
        paddingHorizontal: 24,
        textAlign: 'center',
        fontSize: 24,
        color: theme.colors.text,
        ...Typography.default('semiBold'),
    },
    stateDescription: {
        maxWidth: 360,
        marginBottom: 24,
        paddingHorizontal: 24,
        textAlign: 'center',
        fontSize: 16,
        color: theme.colors.textSecondary,
        ...Typography.default(),
    },
    terminalBlock: {
        backgroundColor: Platform.select({ web: theme.colors.surfaceHighest, default: theme.colors.surfaceHigh }),
        borderRadius: Platform.select({ web: 8, default: 12 }),
        padding: 20,
        marginHorizontal: 24,
        marginBottom: 20,
        borderWidth: 1,
        borderColor: theme.colors.divider,
    },
    terminalText: {
        ...Typography.mono(),
        fontSize: 16,
        color: theme.colors.status.connected,
    },
    terminalTextFirst: {
        marginBottom: 8,
    },
    secondaryAction: {
        minHeight: 40,
        marginTop: 4,
        paddingHorizontal: 14,
        alignItems: 'center',
        justifyContent: 'center',
        borderRadius: 20,
    },
    secondaryActionPressed: {
        backgroundColor: theme.colors.surfacePressedOverlay,
    },
    secondaryActionText: {
        fontSize: 15,
        color: theme.colors.textSecondary,
        ...Typography.default('semiBold'),
    },
}));

/** Commands that link a computer in the corporate fork (OIDC device login, no QR pairing). */
function getLinkCommands(): string[] {
    return [
        '$ npm install -g happycc',
        `$ export HAPPY_SERVER_URL=${getServerUrl()}`,
        '$ happycc auth login',
        '$ happycc',
    ];
}

export function EmptyMainScreen({
    hasArchivedSessions = false,
    onShowArchived,
}: {
    hasArchivedSessions?: boolean;
    onShowArchived?: () => void;
}) {
    const { theme } = useUnistyles();
    const styles = stylesheet;
    const router = useRouter();
    const machines = useAllMachines({ includeOffline: true });
    const machineChoices = React.useMemo(() => collectMachineChoices(machines), [machines]);
    const linkCommands = React.useMemo(() => getLinkCommands(), []);
    const showArchivedAction = hasArchivedSessions && onShowArchived ? (
        <Pressable
            onPress={onShowArchived}
            accessibilityRole="button"
            style={({ pressed }) => [
                styles.secondaryAction,
                pressed && styles.secondaryActionPressed,
            ]}
        >
            <Text style={styles.secondaryActionText}>{t('sidebar.showArchived')}</Text>
        </Pressable>
    ) : null;

    // A linked computer with nothing on it yet. The all-offline case never
    // reaches here: the list wrapper shows the offline checklist for it.
    if (machineChoices.length > 0) {
        return (
            <View style={styles.container}>
                <Ionicons name="terminal-outline" size={56} color={theme.colors.textSecondary} style={styles.stateIcon} />
                <Text style={styles.stateTitle}>No sessions yet</Text>
                <Text style={styles.stateDescription}>Start one on a connected machine.</Text>
                <RoundButton title="Start New Session" size="large" onPress={() => router.navigate('/new')} />
                {showArchivedAction}
            </View>
        );
    }

    return (
        <ScrollView contentContainerStyle={[styles.container, { flexGrow: 1, flex: undefined, paddingVertical: 24 }]}>
            <Text style={styles.title}>{t('components.emptyMainScreen.connectComputer')}</Text>
            <Text style={styles.stateDescription}>
                {brandText('Install the Happy CLI on your computer, sign in with your organization account, and start it. '
                    + 'Your computer shows up here as soon as it connects.')}
            </Text>
            <View style={styles.terminalBlock}>
                {linkCommands.map((line, index) => (
                    <Text
                        key={line}
                        style={[styles.terminalText, index < linkCommands.length - 1 && styles.terminalTextFirst]}
                    >
                        {line}
                    </Text>
                ))}
            </View>
            {showArchivedAction}
        </ScrollView>
    );
}
