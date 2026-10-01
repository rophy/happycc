import * as React from 'react';
import { Ionicons } from '@expo/vector-icons';
import { Stack } from 'expo-router';
import { useUnistyles } from 'react-native-unistyles';
import { Item } from '@/components/Item';
import { ItemGroup } from '@/components/ItemGroup';
import { ItemList } from '@/components/ItemList';
import { useAuth } from '@/auth/AuthContext';
import { getServerLabel } from '@/sync/serverConfig';
import { Modal } from '@/modal';
import { t } from '@/text';

/**
 * The gear on the link-your-computer screen: which server this account lives on, and a way to throw the account away and start again.
 */
export default function OnboardingSettingsScreen() {
    const { theme } = useUnistyles();
    const auth = useAuth();

    const logout = React.useCallback(async () => {
        const confirmed = await Modal.confirm(
            t('onboarding.logoutConfirmTitle'),
            t('onboarding.logoutConfirmBody'),
            { confirmText: t('common.logout'), destructive: true },
        );
        if (confirmed) {
            await auth.logout();
        }
    }, [auth]);

    return (
        <>
            <Stack.Screen
                options={{
                    headerShown: true,
                    headerTitle: t('onboarding.settingsTitle'),
                    headerTitleAlign: 'center',
                    headerBackTitle: t('common.back'),
                }}
            />
            <ItemList>
                <ItemGroup>
                    <Item
                        title={t('onboarding.settingsServer')}
                        detail={getServerLabel()}
                        icon={<Ionicons name="server-outline" size={28} color={theme.colors.textSecondary} />}
                        showChevron={false}
                    />
                </ItemGroup>
                <ItemGroup footer={t('onboarding.logoutFooter')}>
                    <Item
                        title={t('onboarding.logoutStartOver')}
                        icon={<Ionicons name="log-out-outline" size={28} color={theme.colors.textDestructive} />}
                        destructive
                        showChevron={false}
                        onPress={() => { void logout(); }}
                    />
                </ItemGroup>
            </ItemList>
        </>
    );
}
