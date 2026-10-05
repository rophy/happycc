import * as React from 'react';
import { Text, View } from 'react-native';
import { StyleSheet } from 'react-native-unistyles';
import { clearForbidden, useForbidden } from '@/auth/authorization';
import { useAuth } from '@/auth/AuthContext';
import { RoundButton } from '@/components/RoundButton';
import { t } from '@/text';

/** Replaces the app with a "Not authorized" view while the server refuses this device. */
export const NotAuthorizedGate = React.memo((props: { children: React.ReactNode }) => {
    const forbidden = useForbidden();
    const auth = useAuth();
    if (!forbidden) {
        return <>{props.children}</>;
    }
    return (
        <View style={styles.container}>
            <Text style={styles.title}>{t('notAuthorized.title')}</Text>
            <Text style={styles.reason}>{forbidden.reason ?? t('notAuthorized.defaultReason')}</Text>
            <View style={styles.buttons}>
                <RoundButton title={t('common.retry')} onPress={clearForbidden} />
                {auth.isAuthenticated && (
                    <RoundButton title={t('common.logout')} display="inverted" action={async () => { clearForbidden(); await auth.logout(); }} />
                )}
            </View>
        </View>
    );
});

const styles = StyleSheet.create((theme) => ({
    container: { flex: 1, alignItems: 'center', justifyContent: 'center', padding: 24, gap: 16, backgroundColor: theme.colors.groupped.background },
    title: { fontSize: 22, fontWeight: '600', color: theme.colors.text },
    reason: { fontSize: 16, textAlign: 'center', maxWidth: 480, color: theme.colors.textSecondary },
    buttons: { flexDirection: 'row', gap: 12 },
}));
