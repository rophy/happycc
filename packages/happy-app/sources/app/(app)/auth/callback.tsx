import * as React from 'react';
import { ActivityIndicator, Platform, Text, View } from 'react-native';
import { useRouter } from 'expo-router';
import { useUnistyles } from 'react-native-unistyles';
import { useAuth } from '@/auth/AuthContext';
import { completeWebSignIn, discardPendingWebLogin } from '@/auth/signIn';
import { OidcLoginError } from '@/auth/oidcLogin';
import { takeWebCallbackCode } from '@/auth/webCallback';
import { RoundButton } from '@/components/RoundButton';
import { Typography } from '@/constants/Typography';

/**
 * `/auth/callback#code=…`: where the server sends the browser after the IdP.
 * Not behind the sign-in screen, so it can finish signing in.
 */
export default function AuthCallbackScreen() {
    const auth = useAuth();
    const router = useRouter();
    const { theme } = useUnistyles();
    const [error, setError] = React.useState<string | null>(null);
    const started = React.useRef(false);

    React.useEffect(() => {
        if (started.current) {
            return;
        }
        started.current = true;
        if (Platform.OS !== 'web') {
            router.replace('/');
            return;
        }
        if (auth.isAuthenticated) {
            // Already signed in: the stray callback's verifier and key must not linger.
            discardPendingWebLogin();
            router.replace('/');
            return;
        }
        const code = takeWebCallbackCode();
        if (!code) {
            setError('This sign-in link is incomplete. Please sign in again.');
            return;
        }
        (async () => {
            try {
                const credentials = await completeWebSignIn(code);
                await auth.login(credentials);
                router.replace('/');
            } catch (e) {
                // Only our own messages are shown: other errors could quote a response body.
                setError(e instanceof OidcLoginError ? e.message : 'Sign-in failed. Please try again.');
            }
        })();
    }, []);

    return (
        <View style={{ flex: 1, alignItems: 'center', justifyContent: 'center', padding: 32, backgroundColor: theme.colors.groupped.background }}>
            {error ? (
                <>
                    <Text style={{ ...Typography.default(), fontSize: 17, textAlign: 'center', color: theme.colors.text, marginBottom: 24 }}>
                        {error}
                    </Text>
                    <View style={{ width: 280, maxWidth: '100%' }}>
                        <RoundButton title="Back to sign in" onPress={() => router.replace('/')} />
                    </View>
                </>
            ) : (
                <ActivityIndicator size="small" color={theme.colors.textSecondary} />
            )}
        </View>
    );
}
