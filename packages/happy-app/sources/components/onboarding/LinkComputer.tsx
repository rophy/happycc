import * as React from 'react';
import { ActivityIndicator, Pressable, ScrollView, Text, View } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { useRouter } from 'expo-router';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';
import { Typography } from '@/constants/Typography';
import { RoundButton } from '../RoundButton';
import { TerminalBlock } from './TerminalBlock';
import { OnboardingHeader } from './OnboardingHeader';
import { useAllMachines, useLocalSettingMutable } from '@/sync/storage';
import { collectMachineChoices } from '@/sync/machineChoices';
import { Modal } from '@/modal';
import { t, brandText } from '@/text';
import { getServerLabel } from '@/sync/serverConfig';
import { openExternalUrl } from '@/utils/openExternalUrl';
import { appLinks } from '@/config';

/**
 * Where somebody stuck on this screen can turn: the issue tracker the build
 * points at (APP_CONFIG `links.issues`). Without one there is no Get help button.
 */
const HELP_LINKS: readonly { label: () => string; url: string }[] = appLinks.issuesUrl
    ? [{ label: () => t('onboarding.helpIssues'), url: appLinks.issuesUrl }]
    : [];

// Corporate fork: a computer links itself by signing in with `happycc auth login`
// (OIDC device flow). English-only copy until it goes through translation.
const SIGN_IN_STEP_TITLE = 'Sign in on your computer';
const SIGN_IN_STEP_BODY = 'Run this in a terminal and approve the sign-in in your browser.';
const SIGN_IN_COMMAND = 'happycc auth login';
const START_STEP_TITLE = brandText('Start Happy');
const START_STEP_BODY = 'This screen updates as soon as your computer connects.';

/** Room kept under the checklist so the corner button never covers its last row. */
const GET_HELP_RESERVED_HEIGHT = 56;
const SCROLL_BOTTOM_PADDING = 48;

type ChecklistRowProps = {
    checked: boolean;
    title: string;
    /** Tapping the row toggles it. Rows without this are read-only. */
    onToggle?: () => void;
    /** Shown under the title while the row is unchecked. */
    children?: React.ReactNode;
    busy?: boolean;
    dimmed?: boolean;
};

/**
 * One box on the list. A checked row folds its body away so the list gets
 * shorter as the person works down it; the unchecked rows are the ones with
 * something left to read.
 */
const ChecklistRow = React.memo(function ChecklistRow({
    checked,
    title,
    onToggle,
    children,
    busy,
    dimmed,
}: ChecklistRowProps) {
    const { theme } = useUnistyles();
    const box = busy ? (
        <ActivityIndicator size="small" color={theme.colors.textSecondary} />
    ) : (
        <Ionicons
            name={checked ? 'checkmark-circle' : 'ellipse-outline'}
            size={26}
            color={checked ? theme.colors.success : theme.colors.textSecondary}
        />
    );
    return (
        <View style={styles.row}>
            <Pressable
                onPress={onToggle}
                disabled={!onToggle}
                accessibilityRole={onToggle ? 'checkbox' : undefined}
                accessibilityState={onToggle ? { checked } : undefined}
                hitSlop={8}
                style={({ pressed }) => [styles.rowHead, pressed && onToggle && styles.rowHeadPressed]}
            >
                <View style={styles.box}>{box}</View>
                <Text style={[styles.rowTitle, (checked || dimmed) && styles.rowTitleDone]}>{title}</Text>
            </Pressable>
            {!checked && children ? (
                <View style={styles.rowBody}>{children}</View>
            ) : null}
        </View>
    );
});

/**
 * The link-your-computer checklist. `link` is the first run: nothing is linked
 * yet. `offline` is the same list once a computer is linked but none can be
 * reached: the job is to get Happy running again.
 */
export const LinkComputerChecklist = React.memo(function LinkComputerChecklist({
    variant,
    onShowArchived,
    bottomInset = 0,
}: {
    variant: 'link' | 'offline';
    /** Archive-only accounts keep a way to their archive while offline. */
    onShowArchived?: () => void;
    /** Extra room under the content for anything floating over it. */
    bottomInset?: number;
}) {
    const router = useRouter();
    const machines = useAllMachines({ includeOffline: true });
    const choices = React.useMemo(() => collectMachineChoices(machines), [machines]);
    const [ticked, setTicked] = useLocalSettingMutable('linkComputerChecklist');

    const toggle = React.useCallback((key: 'install' | 'open') => {
        setTicked({ ...ticked, [key]: !ticked[key] });
    }, [setTicked, ticked]);

    if (variant === 'offline') {
        const title = choices.length === 1
            ? t('onboarding.offlineTitleOne', { name: choices[0].name })
            : t('onboarding.offlineTitleMany');
        const linked = choices.length === 1
            ? t('onboarding.offlineLinkedStep', { name: choices[0].name })
            : t('onboarding.offlineLinkedStepMany', { count: choices.length });
        return (
            <ScrollView contentContainerStyle={[styles.scroll, { paddingBottom: SCROLL_BOTTOM_PADDING + bottomInset }]} keyboardShouldPersistTaps="handled">
                <View style={styles.content}>
                    <Text style={styles.title}>{title}</Text>
                    <ChecklistRow checked title={linked} />
                    <ChecklistRow checked={false} title={t('onboarding.offlineOpenStep')}>
                        {/* onboarding.offlineOpenBody is not shown: it points at the upstream desktop app. */}
                        <TerminalBlock
                            style={styles.terminal}
                            lines={[{ kind: 'command', text: t('onboarding.terminalRun') }]}
                        />
                    </ChecklistRow>
                    <View style={styles.actions}>
                        <View style={styles.button}>
                            <RoundButton
                                title={t('onboarding.offlineTroubleshoot')}
                                onPress={() => router.push('/troubleshoot')}
                            />
                        </View>
                        {onShowArchived ? (
                            <View style={styles.button}>
                                <RoundButton
                                    size="normal"
                                    display="inverted"
                                    title={t('sidebar.showArchived')}
                                    onPress={onShowArchived}
                                />
                            </View>
                        ) : null}
                    </View>
                </View>
            </ScrollView>
        );
    }

    return (
        <ScrollView contentContainerStyle={[styles.scroll, { paddingBottom: SCROLL_BOTTOM_PADDING + bottomInset }]} keyboardShouldPersistTaps="handled">
            <View style={styles.content}>
                <ChecklistRow
                    checked={!!ticked.install}
                    title={t('onboarding.installStep')}
                    onToggle={() => toggle('install')}
                >
                    <TerminalBlock
                        style={styles.terminal}
                        lines={[{ kind: 'command', text: t('onboarding.terminalInstall') }]}
                    />
                </ChecklistRow>
                <ChecklistRow
                    checked={!!ticked.open}
                    title={SIGN_IN_STEP_TITLE}
                    onToggle={() => toggle('open')}
                >
                    <Text style={styles.body}>{SIGN_IN_STEP_BODY}</Text>
                    <TerminalBlock style={styles.terminal} lines={[{ kind: 'command', text: SIGN_IN_COMMAND }]} />
                </ChecklistRow>
                <ChecklistRow checked={false} title={START_STEP_TITLE}>
                    <Text style={styles.body}>{START_STEP_BODY}</Text>
                    <TerminalBlock
                        style={styles.terminal}
                        lines={[{ kind: 'command', text: t('onboarding.terminalRun') }]}
                    />
                </ChecklistRow>
            </View>
        </ScrollView>
    );
});

/**
 * Somewhere to turn without leaving the step you are stuck on. The options
 * arrive as the app's ordinary alert — a native sheet on a phone, the web
 * modal in a browser — so this adds a corner button, not a new surface.
 */
export const GetHelpButton = React.memo(function GetHelpButton() {
    const { theme } = useUnistyles();

    const openHelp = React.useCallback(() => {
        Modal.alert(
            t('onboarding.getHelp'),
            t('onboarding.helpMessage'),
            [
                ...HELP_LINKS.map((link) => ({
                    text: link.label(),
                    onPress: () => { void openExternalUrl(link.url); },
                })),
                { text: t('common.cancel'), style: 'cancel' as const },
            ],
        );
    }, []);

    return (
        <Pressable
            onPress={openHelp}
            accessibilityRole="button"
            accessibilityLabel={t('onboarding.getHelp')}
            hitSlop={8}
            style={({ pressed }) => [styles.getHelp, pressed && styles.getHelpPressed]}
        >
            <Ionicons name="help-circle-outline" size={17} color={theme.colors.textSecondary} />
            <Text style={styles.getHelpText}>{t('onboarding.getHelp')}</Text>
        </Pressable>
    );
});

/**
 * The first-run screen: the checklist under its own header, in place of the
 * session list and its dock. Shown at the home route once the account exists
 * and no machine has been linked yet.
 */
export const OnboardingLinkComputer = React.memo(function OnboardingLinkComputer() {
    const router = useRouter();
    const { theme } = useUnistyles();
    const insets = useSafeAreaInsets();
    return (
        <View style={styles.root}>
            <OnboardingHeader
                title={t('onboarding.linkTitle')}
                subtitle={getServerLabel()}
                headerRight={() => (
                    <Pressable
                        onPress={() => router.push('/onboarding/settings')}
                        hitSlop={15}
                        accessibilityRole="button"
                        accessibilityLabel={t('onboarding.settingsTitle')}
                        style={styles.headerButton}
                    >
                        <Ionicons name="settings-outline" size={22} color={theme.colors.header.tint} />
                    </Pressable>
                )}
            />
            <LinkComputerChecklist variant="link" bottomInset={HELP_LINKS.length > 0 ? GET_HELP_RESERVED_HEIGHT : 0} />
            {HELP_LINKS.length > 0 && (
                <View style={[styles.getHelpCorner, { bottom: insets.bottom + 12 }]} pointerEvents="box-none">
                    <GetHelpButton />
                </View>
            )}
        </View>
    );
});

const styles = StyleSheet.create((theme) => ({
    root: {
        flex: 1,
        backgroundColor: theme.colors.groupped.background,
    },
    headerButton: {
        width: 32,
        height: 32,
        alignItems: 'center',
        justifyContent: 'center',
    },
    scroll: {
        alignItems: 'center',
        paddingTop: 16,
    },
    // Sits over the checklist rather than under it, so a short list keeps the
    // button at the bottom of the screen instead of floating mid-page.
    getHelpCorner: {
        position: 'absolute',
        right: 16,
        alignItems: 'flex-end',
    },
    getHelp: {
        flexDirection: 'row',
        alignItems: 'center',
        gap: 6,
        minHeight: 36,
        paddingHorizontal: 12,
        borderRadius: 18,
    },
    getHelpPressed: {
        backgroundColor: theme.colors.surfacePressedOverlay,
    },
    getHelpText: {
        ...Typography.default('semiBold'),
        fontSize: 15,
        color: theme.colors.textSecondary,
    },
    content: {
        width: '100%',
        maxWidth: 480,
        paddingHorizontal: 24,
    },
    title: {
        ...Typography.default('semiBold'),
        fontSize: 24,
        lineHeight: 30,
        color: theme.colors.text,
        marginBottom: 16,
        paddingHorizontal: 4,
    },
    row: {
        marginBottom: 20,
    },
    rowHead: {
        flexDirection: 'row',
        alignItems: 'center',
        gap: 12,
        minHeight: 32,
    },
    rowHeadPressed: {
        opacity: 0.6,
    },
    box: {
        width: 26,
        height: 26,
        alignItems: 'center',
        justifyContent: 'center',
    },
    rowTitle: {
        ...Typography.default('semiBold'),
        flex: 1,
        fontSize: 17,
        lineHeight: 22,
        color: theme.colors.text,
    },
    rowTitleDone: {
        color: theme.colors.textSecondary,
    },
    rowBody: {
        paddingLeft: 38,
        paddingTop: 6,
    },
    body: {
        ...Typography.default(),
        fontSize: 15,
        lineHeight: 21,
        color: theme.colors.textSecondary,
    },
    link: {
        color: theme.colors.text,
        textDecorationLine: 'underline',
    },
    terminal: {
        marginTop: 12,
    },
    actions: {
        alignItems: 'flex-start',
        marginTop: 6,
    },
    button: {
        width: 260,
        maxWidth: '100%',
        marginBottom: 8,
    },
    connected: {
        paddingLeft: 38,
        color: theme.colors.success,
    },
}));
