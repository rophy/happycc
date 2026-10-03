import * as React from 'react';
import { Header } from './navigation/Header';
import { Platform, Pressable, View } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { useRouter } from 'expo-router';
import { getServerInfo } from '@/sync/serverConfig';
import { Image } from 'expo-image';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';
import { t } from '@/text';
import { ShortcutHintBadge, useShortcutHints } from './ShortcutHints';
import { HomeHeaderTitle } from './HomeHeaderTitle';
import { workstationOnly } from '@/config';
import { OnboardingHeader } from './onboarding/OnboardingHeader';

const HEADER_LOGO_SIZE = 19;

function formatServer(info: { hostname: string; port?: number }): string {
    return info.hostname + (info.port ? `:${info.port}` : '');
}

const stylesheet = StyleSheet.create((theme, runtime) => ({
    headerButton: {
        // marginHorizontal: 4,
        width: 32,
        height: 32,
        alignItems: 'center',
        justifyContent: 'center',
    },
    headerButtonShortcutActive: {
        borderRadius: 8,
        backgroundColor: theme.colors.surfaceSelected,
    },
    headerShortcutBadge: {
        position: 'absolute',
        top: -8,
        right: -12,
    },
    iconButton: {
        color: theme.colors.header.tint,
    },
    logoContainer: {
        // marginHorizontal: 4,
        width: 32,
        height: 32,
        alignItems: 'center',
        justifyContent: 'center',
        tintColor: theme.colors.header.tint,
    },
}));


export const HomeHeader = React.memo(() => {
    const { theme } = useUnistyles();
    const header = (
        <Header
            title={<HomeHeaderTitle title={t('sidebar.sessionsTitle')} />}
            // Workstation-only: no new-session button; sessions start on the workstation.
            headerRight={workstationOnly ? undefined : () => <HeaderRight />}
            headerLeft={() => <HeaderLeft />}
            headerLeftGlass={Platform.OS !== 'web'}
            headerShadowVisible={false}
            headerTransparent={true}
            mobileTitleSurface="plain"
            mobileTitleAlignment="center"
        />
    );

    return Platform.OS === 'web'
        ? <View style={{ backgroundColor: theme.colors.groupped.background }}>{header}</View>
        : header;
})

/**
 * The sign-in screen's header: no title, logo or socket status; only the
 * server this build signs in to.
 */
export const HomeHeaderNotAuth = React.memo(() => {
    return (
        <OnboardingHeader
            subtitle={formatServer(getServerInfo())}
        />
    )
});

function HeaderRight() {
    const router = useRouter();
    const styles = stylesheet;
    const { theme } = useUnistyles();
    const { visible: shortcutHintsVisible } = useShortcutHints();

    return (
        <Pressable
            onPress={() => router.navigate('/new')}
            hitSlop={15}
            style={[
                styles.headerButton,
                shortcutHintsVisible && styles.headerButtonShortcutActive,
            ]}
        >
            <Ionicons name="add-outline" size={28} color={theme.colors.header.tint} />
            <ShortcutHintBadge shortcutKey="N" style={styles.headerShortcutBadge} />
        </Pressable>
    );
}

function HeaderLeft() {
    const styles = stylesheet;
    const { theme } = useUnistyles();
    return (
        <View style={styles.logoContainer}>
            <Image
                source={require('@/assets/images/logo-black.png')}
                contentFit="contain"
                style={{ width: HEADER_LOGO_SIZE, height: HEADER_LOGO_SIZE }}
                tintColor={theme.colors.header.tint}
            />
        </View>
    );
}
