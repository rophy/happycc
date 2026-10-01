import * as React from 'react';
import { View, Pressable, Platform, Text as RNText } from 'react-native';
import { StyleSheet } from 'react-native-unistyles';
import * as Clipboard from 'expo-clipboard';
import { HorizontalScrollView } from '../HorizontalScrollView';
import { SimpleSyntaxHighlighter } from '../SimpleSyntaxHighlighter';
import { Text } from '../StyledText';
import { Modal } from '@/modal';
import { t } from '@/text';
import { Typography } from '@/constants/Typography';

// Shared plain code-block renderer: markdown ```code``` blocks and the
// native mermaid fallback (no configured script URL) both go through this,
// so there is exactly one "render text as a code block" implementation.
export function RenderCodeBlock(props: { content: string, language: string | null, first: boolean, last: boolean, selectable: boolean }) {
    const [isHovered, setIsHovered] = React.useState(false);

    const copyCode = React.useCallback(async () => {
        try {
            await Clipboard.setStringAsync(props.content);
            Modal.alert(t('common.success'), t('markdown.codeCopied'), [{ text: t('common.ok'), style: 'cancel' }]);
        } catch (error) {
            console.error('Failed to copy code:', error);
            Modal.alert(t('common.error'), t('markdown.copyFailed'), [{ text: t('common.ok'), style: 'cancel' }]);
        }
    }, [props.content]);

    return (
        <View
            style={[style.codeBlock, props.first && style.first, props.last && style.last]}
            // @ts-ignore - Web only events
            onMouseEnter={() => setIsHovered(true)}
            // @ts-ignore - Web only events
            onMouseLeave={() => setIsHovered(false)}
        >
            {props.language && <RNText selectable={props.selectable} style={style.codeLanguage}>{props.language}</RNText>}
            <HorizontalScrollView
                contentContainerStyle={{ paddingHorizontal: 16, paddingVertical: 16 }}
            >
                <SimpleSyntaxHighlighter
                    code={props.content}
                    language={props.language}
                    selectable={props.selectable}
                />
            </HorizontalScrollView>
            <View
                style={[style.copyButtonWrapper, isHovered && style.copyButtonWrapperVisible]}
                {...(Platform.OS === 'web' ? ({ className: 'copy-button-wrapper' } as any) : {})}
            >
                <Pressable
                    style={style.copyButton}
                    onPress={copyCode}
                >
                    <Text style={style.copyButtonText}>{t('common.copy')}</Text>
                </Pressable>
            </View>
        </View>
    );
}

const style = StyleSheet.create((theme) => ({
    codeBlock: {
        backgroundColor: theme.colors.surfaceHighest,
        borderRadius: 8,
        marginVertical: 8,
        position: 'relative',
        zIndex: 1,
        width: '100%',
    },
    first: {
        // marginTop: 0
    },
    last: {
        // marginBottom: 0
    },
    copyButtonWrapper: {
        position: 'absolute',
        top: 8,
        right: 8,
        opacity: 0,
        zIndex: 10,
        elevation: 10,
        pointerEvents: 'none',
    },
    copyButtonWrapperVisible: {
        opacity: 1,
        pointerEvents: 'auto',
    },
    codeLanguage: {
        ...Typography.mono(),
        color: theme.colors.textSecondary,
        fontSize: 12,
        marginTop: 8,
        paddingHorizontal: 16,
        marginBottom: 0,
    },
    copyButton: {
        backgroundColor: theme.colors.surfaceHighest,
        paddingHorizontal: 8,
        paddingVertical: 4,
        borderRadius: 4,
        borderWidth: 1,
        borderColor: theme.colors.divider,
        cursor: 'pointer',
    },
    copyButtonText: {
        ...Typography.default(),
        color: theme.colors.text,
        fontSize: 12,
        lineHeight: 16,
    },
}));
