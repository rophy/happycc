import { RoundButton } from "@/components/RoundButton";
import { useAuth } from "@/auth/AuthContext";
import { Text, View, Platform } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import * as React from 'react';
import { StyleSheet } from "react-native-unistyles";
import { useIsLandscape } from "@/utils/responsive";
import { Typography } from "@/constants/Typography";
import { HomeHeaderNotAuth } from "@/components/HomeHeader";
import { MainView } from "@/components/MainView";
import { OnboardingLinkComputer } from "@/components/onboarding/LinkComputer";
import { shouldShowFirstRunInstall } from "@/components/onboarding/firstRunOnboarding";
import { useAllMachines, useIsDataReady } from "@/sync/storage";
import { t } from '@/text';
import { isRunningOnMac } from '@/utils/platform';
import { signIn } from "@/auth/signIn";
import { OidcLoginError } from "@/auth/oidcLogin";
import { Modal } from "@/modal";
import { BrandLogotype } from "@/components/BrandLogotype";

export default function Home() {
    const auth = useAuth();
    if (!auth.isAuthenticated) {
        return <NotAuthenticated />;
    }
    return (
        <Authenticated />
    )
}

function Authenticated() {
    const isDataReady = useIsDataReady();
    const machines = useAllMachines({ includeOffline: true });
    // Until a computer is linked there is nothing for the home chrome to do:
    // the dock, filters, session list, and tablet sidebar all need a machine.
    // Native phones and tablets therefore share the same link screen. Web
    // and desktop retain their existing account-linking flow.
    const showInstallStep = shouldShowFirstRunInstall({
        isAuthenticated: true,
        isDataReady,
        machineCount: machines.length,
        isWeb: Platform.OS === 'web',
        isRunningOnMac: isRunningOnMac(),
    });
    if (showInstallStep) {
        return <OnboardingLinkComputer />;
    }
    return <MainView variant="phone" />;
}

function NotAuthenticated() {
    const auth = useAuth();
    const isLandscape = useIsLandscape();
    const insets = useSafeAreaInsets();

    const signInWithOrganization = async () => {
        try {
            const credentials = await signIn();
            if (credentials) {
                await auth.login(credentials);
            }
        } catch (error) {
            // Only our own messages are shown or logged: other errors (e.g. a JSON parse
            // error) could quote a response body that carries tokens.
            console.error('Sign-in failed:', error instanceof Error ? error.name : 'unknown error');
            Modal.alert(t('common.error'), error instanceof OidcLoginError ? error.message : 'Sign-in failed. Please try again.');
        }
    };

    const actions = (
        <View style={styles.buttonContainer}>
            <RoundButton title="Sign in" action={signInWithOrganization} />
        </View>
    );

    const logo = <BrandLogotype />;

    const portraitLayout = (
        <View style={styles.portraitContainer}>
            {logo}
            <Text style={styles.title}>
                {t('onboarding.headline')}
            </Text>
            <Text style={styles.subtitle}>
                {'Sign in with your organization account.'}
            </Text>
            {actions}
        </View>
    );

    const landscapeLayout = (
        <View style={[styles.landscapeContainer, { paddingBottom: insets.bottom + 24 }]}>
            <View style={styles.landscapeInner}>
                <View style={styles.landscapeLogoSection}>
                    {logo}
                </View>
                <View style={styles.landscapeContentSection}>
                    <Text style={styles.landscapeTitle}>
                        {t('onboarding.headline')}
                    </Text>
                    <Text style={styles.landscapeSubtitle}>
                        {'Sign in with your organization account.'}
                    </Text>
                    {actions}
                </View>
            </View>
        </View>
    );

    return (
        <>
            <HomeHeaderNotAuth />
            {isLandscape ? landscapeLayout : portraitLayout}
        </>
    )
}

const styles = StyleSheet.create((theme) => ({
    // NotAuthenticated styles
    portraitContainer: {
        flex: 1,
        alignItems: 'center',
        justifyContent: 'center',
        paddingHorizontal: 32,
    },
    title: {
        marginTop: 16,
        textAlign: 'center',
        fontSize: 24,
        lineHeight: 30,
        ...Typography.default('semiBold'),
        color: theme.colors.text,
    },
    subtitle: {
        ...Typography.default(),
        fontSize: 17,
        lineHeight: 22,
        color: theme.colors.textSecondary,
        marginTop: 12,
        textAlign: 'center',
        marginBottom: 48,
    },
    buttonContainer: {
        width: 280,
        maxWidth: '100%',
        marginBottom: 8,
    },
    // Landscape styles
    landscapeContainer: {
        flexBasis: 0,
        flexGrow: 1,
        flexDirection: 'row',
        alignItems: 'center',
        justifyContent: 'center',
        paddingHorizontal: 48,
    },
    landscapeInner: {
        flexGrow: 1,
        flexBasis: 0,
        maxWidth: 800,
        flexDirection: 'row',
    },
    landscapeLogoSection: {
        flexBasis: 0,
        flexGrow: 1,
        alignItems: 'center',
        justifyContent: 'center',
        paddingRight: 24,
    },
    landscapeContentSection: {
        flexBasis: 0,
        flexGrow: 1,
        alignItems: 'center',
        justifyContent: 'center',
        paddingLeft: 24,
    },
    landscapeTitle: {
        textAlign: 'center',
        fontSize: 24,
        lineHeight: 30,
        ...Typography.default('semiBold'),
        color: theme.colors.text,
    },
    landscapeSubtitle: {
        ...Typography.default(),
        fontSize: 17,
        lineHeight: 22,
        color: theme.colors.textSecondary,
        marginTop: 12,
        textAlign: 'center',
        marginBottom: 32,
        paddingHorizontal: 16,
    },
}));
